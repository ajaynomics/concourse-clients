import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, dirname, isAbsolute } from "node:path";
import { TokenClient, validateConfig, type Config } from "./auth.ts";
import { PrivateFiles, FileJournal } from "./storage.ts";
import { Client } from "./client.ts";
import { Mailbox } from "./delivery.ts";
import { Outbox } from "./outgoing.ts";
import { Replies } from "./replies.ts";
import { doorbell } from "./doorbell.ts";
import { SafeError, type Fetch } from "./http.ts";
import { Lifetime } from "./lifetime.ts";
import { attention, statusLine } from "./status.ts";
import { answer } from "./format.ts";
type CustomMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
export const ANSWER_TYPE = "concourse-v3.answer";

export const explain = (e: unknown) => e instanceof SafeError ? e.message : "V3 operation blocked; inspect private configuration/ledger offline";

// V3 tenants share identity checks; legacy staging and its `default` profile stay isolated.
export function openProfile(path: string): { files: PrivateFiles; config: Config } {
  if (!isAbsolute(path) || !path.endsWith("/config.json")) throw new SafeError("EXPLICIT_PRIVATE_CONFIG_REQUIRED");
  if (basename(dirname(path)) === "default") throw new SafeError("LEGACY_PROFILE_REFUSED");
  const files = new PrivateFiles(dirname(path));
  try {
    const candidate = files.read<Config>("config.json");
    const config = validateConfig(candidate!);
    if (/(^|\.)concourse\.example\.com$/.test(new URL(config.origin).hostname)) throw new SafeError("LEGACY_PROFILE_REFUSED");
    return { files, config };
  } catch (e) { files.close(); throw e; }
}

// What every profile shares: the one Pi session and the extension's generation.
export interface Host { pi: ExtensionAPI; fetchImpl: Fetch; current(r: Runtime): boolean; labelled(): boolean }

// One profile: its own consumer lock, tokens, client, ledger, mailbox, outbox, doorbell and timers.
export class Runtime {
  readonly id: string; readonly label: string; readonly sessionId: string;
  readonly life: Lifetime; readonly journal: FileJournal; readonly tokens: TokenClient; readonly client: Client;
  readonly mailbox: Mailbox; readonly outbox: Outbox; readonly replies: Replies;
  connected = false; checkedAt?: number; failures = 0; lastError?: string;
  private release: () => void; private refreshing?: Promise<void>; private following?: Promise<void>;
  private reconnect?: ReturnType<typeof setTimeout>; private backstop?: ReturnType<typeof setInterval>;

  constructor(private host: Host, public ctx: ExtensionContext, readonly files: PrivateFiles, readonly config: Config, readonly statusKey: string) {
    const where = new URL(config.origin).host;
    this.id = `${where}/${config.owner}/${config.agent}`; this.label = `${where} · ${config.owner}/${config.agent}`;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.release = files.acquire();
    this.life = new Lifetime(() => host.current(this) && this.ctx.sessionManager.getSessionId() === this.sessionId && files.ownsConsumer());
    this.journal = new FileJournal(files); this.tokens = new TokenClient(config, files, host.fetchImpl, Date.now, this.life.check);
    this.client = new Client(config, () => this.tokens.token(), host.fetchImpl, this.life.alive);
    this.mailbox = new Mailbox(this.journal, { sessionId: () => this.ctx.sessionManager.getSessionId(), inject: message => this.followUp(message) }, this.sessionId, this.life.check);
    this.outbox = new Outbox(this.journal, this.client, this.life.check); this.replies = new Replies(this.journal, this.client, this.life.check);
  }
  matches(name: string): boolean { return name === this.id || name === this.label; }
  received(taskId: string): boolean { return Object.values(this.journal.load().batches).some(b => b.taskId === taskId); }
  sent(messageId: string): boolean { return !!this.journal.load().outgoing[messageId]; }
  notify(text: string, level: "info" | "warning" = "info"): void { this.ctx.ui.notify(this.host.labelled() ? `[${this.label}] ${text}` : text, level); }

  start(): void {
    this.mailbox.recover(); this.status();
    void this.connect().catch(e => this.status(explain(e)));
    this.backstop = setInterval(() => { if (this.life.alive()) void this.refresh().catch(e => this.status(explain(e))); }, 60_000); this.backstop.unref();
  }
  // Drain only our I/O before releasing the profile lock; never abort or clear Pi's queues.
  stop(): Promise<void> {
    this.life.invalidate(); if (this.reconnect) clearTimeout(this.reconnect); if (this.backstop) clearInterval(this.backstop);
    return (async () => { await this.life.drain(); this.release(); this.files.close(); })();
  }

  // Single-profile content stays byte-identical; several profiles label each message with its origin.
  private followUp(message: CustomMessage): void {
    this.life.check();
    const labelled = this.host.labelled() && typeof message.content === "string"
      ? { ...message, content: `[${this.label}] ${message.content}`, details: { ...(message.details as object), profile: this.id } } : message;
    this.host.pi.sendMessage(labelled, { triggerTurn: true, deliverAs: "followUp" });
  }
  offerAnswer(id: string): void {
    this.life.check(); const value = this.outbox.take(id); if (value === undefined) return;
    this.followUp({ customType: ANSWER_TYPE, display: true, details: { answerId: id, sessionId: this.sessionId }, content: answer(value) });
  }

  // A failure message counts as a failed check until the next successful refresh.
  status(failure?: string): void {
    if (!this.life.alive()) return;
    if (failure) { this.failures++; this.lastError = failure; }
    let counts = { mail: 0, unconfirmed: 0, blocked: 0 };
    try { counts = attention(this.journal.load(), this.sessionId); } catch { /* the footer never blocks on a ledger read */ }
    this.ctx.ui.setStatus(this.statusKey, statusLine({ handle: `${this.config.owner}/${this.config.agent}`, host: new URL(this.config.origin).host, live: this.connected, checkedAt: this.checkedAt, lastOkAt: this.checkedAt, error: this.lastError, failures: this.failures }, counts));
  }
  report(): string {
    const l = this.journal.load();
    return [
      ...Object.values(l.outgoing).filter(o => ["prepared", "uncertain"].includes(o.phase)).map(o => `Unconfirmed send ${o.messageId} to ${o.recipient}: publication may have occurred; /concourse-v3 reconcile ${o.messageId}; do not resend`),
      ...Object.values(l.replies ?? {}).filter(x => ["prepared", "uncertain"].includes(x.phase)).map(x => `Unconfirmed reply ${x.id} on Task ${x.taskId}: publication may have occurred; read the original Task before retrying; do not repeat the reply`),
      ...Object.entries(l.blockedInbox ?? {}).map(([id, b]) => `Blocked incoming Task ${id}: ${b.code}`),
      ...Object.entries(l.blockedAnswers ?? {}).map(([id, b]) => `Blocked answer Task ${id}: ${b.code}`),
    ].join("\n") || "Nothing needs attention";
  }

  // Doorbell hints never wait for the refresh; refresh() already coalesces overlapping requests.
  private kick(): void { void Promise.resolve().then(() => this.refresh()).catch(e => this.status(explain(e))); }
  refresh(): Promise<void> {
    this.life.check();
    if (this.refreshing) {
      // A caller joining older I/O waits for the coalesced subsequent read it requested.
      if (!this.following) {
        const next = () => { this.following = undefined; return this.refresh(); };
        this.following = this.refreshing.then(next, next);
      }
      return this.following;
    }
    const job = this.life.run(async () => {
      // Always inspect new mail at the head, and advance a separate bounded tail for catch-up.
      const cursor = this.journal.load().cursors.inbox, head = await this.client.inbox(); this.life.check();
      const page = cursor ? await this.client.inbox(cursor) : head; this.life.check();
      for (const t of (page === head ? head.tasks : [...head.tasks, ...page.tasks])) {
        this.life.check();
        try { this.mailbox.enqueue(t); }
        catch (e) {
          this.life.check();
          if (!(e instanceof SafeError) || !["DELIVERY_MESSAGE_LIMIT", "DUPLICATE_CALLER_IDS"].includes(e.code)) throw e;
          const diagnostic = this.journal.load(); diagnostic.blockedInbox ??= {}; diagnostic.blockedInbox[t.id] = { code: e.code }; this.journal.save(diagnostic);
        }
      }
      const l = this.journal.load();
      for (const blocked of [...head.blockedTasks, ...page.blockedTasks]) { l.blockedInbox ??= {}; l.blockedInbox[blocked.taskId] = { code: blocked.code }; }
      if (page.nextPageToken) l.cursors.inbox = page.nextPageToken; else delete l.cursors.inbox;
      this.journal.save(l); this.mailbox.flush();
      // Answers already stored are offered even when this sweep fails.
      let failure: unknown;
      try { await this.outbox.sweep(); } catch (e) { failure = e; }
      this.life.check();
      for (const o of this.outbox.offers()) this.offerAnswer(o.messageId);
      if (failure) throw failure;
      this.checkedAt = Date.now(); this.failures = 0; this.lastError = undefined; this.status();
    });
    this.refreshing = job; const finish = () => { this.refreshing = undefined; }; void job.then(finish, finish);
    return job;
  }
  private connect(): Promise<void> {
    return this.life.run(async () => {
      try {
        await this.client.identity(); this.life.check(); const token = await this.tokens.token(); this.life.check();
        await doorbell({ config: this.config, token, sessionId: this.sessionId, signal: this.life.controller.signal, fetchImpl: this.host.fetchImpl,
          ready: () => { this.life.check(); this.connected = true; this.status(); this.kick(); },
          hint: () => this.kick(),
        });
        this.connected = false; this.status();
      } catch (e) { this.connected = false; this.status(explain(e)); }
      finally { if (this.life.alive()) { this.connected = false; this.reconnect = setTimeout(() => { if (this.life.alive()) void this.connect().catch(e => this.status(explain(e))); }, 30_000); this.reconnect.unref(); } }
    });
  }
}
