import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SafeError, type Fetch } from "../../pi/concourse-v3/src/http.ts";
import { fullTaskId, qualifiedRecipient, RECIPIENT_PATTERN } from "../../pi/concourse-v3/src/client.ts";
import { CommandError, runAction, validatePayload, withProfile } from "../../pi/concourse-v3/src/commands.ts";
import { AUTOMATIC_V3_ORIGIN, doctor, handle, join as joinConcourse, login, signup, type SetupDependencies, type SetupEvent } from "../../pi/concourse-v3/src/onboarding.ts";
import { deliverCallback } from "../../pi/concourse-v3/src/callback.ts";
import { object, terminal, type Task } from "../../pi/concourse-v3/src/types.ts";
import { help, listState, parse, resolveProfile, STATES, taskState, UsageError, type Parsed } from "./args.ts";
import { ownerAction } from "./owner.ts";
import * as show from "./render.ts";

export const PACKAGE = "concourse-cli";
export const EXIT = { ok: 0, failed: 1, choose: 2, unanswered: 3, usage: 64 } as const;
export interface Io {
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
  fetchImpl?: Fetch;
  open?(url: string): Promise<void>;
  stdin?(): Promise<string>;
  sleep?(ms: number, signal: AbortSignal): Promise<unknown>;
  now?(): number;
  signal?: AbortSignal;
  setupTimeoutMs?: number;
  platform?: string;
}
const STDIN_LIMIT = 256 * 1024;
export function processIo(): Io {
  return {
    out: line => { process.stdout.write(`${line}\n`); },
    err: line => { process.stderr.write(`${line}\n`); },
    env: process.env,
    stdin: async () => {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > STDIN_LIMIT) throw new UsageError("Standard input is larger than 256 KiB.");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
export function version(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    try { const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); if (p.name === PACKAGE && typeof p.version === "string") return p.version; } catch { /* keep looking */ }
    if (dirname(dir) === dir) return "unknown";
  }
}
export async function openBrowser(url: string): Promise<void> {
  // Only validated HTTPS action URLs reach this spawn; never through a shell.
  if (new URL(url).protocol !== "https:") throw new SafeError("BROWSER_URL_REFUSED");
  const child = spawn("xdg-open", [url], { stdio: "ignore", shell: false });
  await new Promise<void>(resolve => { child.once("error", () => resolve()); child.once("spawn", () => { child.unref(); resolve(); }); });
}
// Shared onboarding text names the repository launcher; this package installs `concourse`.
const cliText = (text: string) => text.replaceAll("script/concourse-v3", "concourse");

export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  let json = argv.includes("--json");
  try {
    const p = parse(argv); json = p.json;
    if (p.command === "version") { io.out(version()); return EXIT.ok; }
    if (p.command === "help") { io.out(help(p.topic)); return EXIT.ok; }
    // Profiles are Linux private files guarded by kernel flock, as in the Pi extension.
    if ((io.platform ?? process.platform) !== "linux" || Number(process.versions.node.split(".")[0]) < 24) throw new SafeError("REQUIRES_LINUX_NODE_24", false, undefined, {}, "Concourse profiles need Linux (private files and kernel flock) and Node 24 or later.");
    return await run(p, io);
  } catch (e) { return failed(e, json, io); }
}

async function run(p: Parsed, io: Io): Promise<number> {
  const fetchImpl = io.fetchImpl ?? fetch, a = p.args, f = p.flags;
  const text = (name: string) => typeof f[name] === "string" ? f[name] as string : undefined;
  const say = (value: unknown, human: string) => io.out(p.json ? JSON.stringify(value) : human);
  const done = (result: unknown, human: string, extra: Record<string, unknown> = {}) => { say({ phase: "complete", command: p.command, ...extra, result }, human); return EXIT.ok; };
  const profile = () => configured(resolveProfile(p.profile, io.env));
  switch (p.command) {
    case "join": case "signup": case "login": return setup(p, io, fetchImpl);
    case "callback": {
      await deliverCallback(a.url);
      say({ phase: "complete", command: "callback", accepted: true }, "Callback accepted. The waiting sign-in continues.");
      return EXIT.ok;
    }
    case "doctor": {
      const path = profile(), result = await doctor(path, fetchImpl), i = result.identity;
      say(result, `Healthy: ${show.clean(`${i.organization}/${i.owner}/${i.agent}`)} at ${show.clean(i.origin)}\nProfile: ${path}`);
      return EXIT.ok;
    }
    case "whoami": {
      const path = profile();
      const result = await withProfile(path, fetchImpl, async ({ client, config }) => ({ ...(await client.identity()), origin: config.origin, profile: path }));
      return done(result, `${show.clean(`${result.organization}/${result.owner}/${result.handle}`)} (agent id ${result.agent_id}) at ${show.clean(result.origin)}\nProfile: ${path}`);
    }
    case "agents": {
      if (a.query !== undefined && a.query.length > 2048) throw new UsageError("QUERY is too long.");
      const result = await runAction("find", profile(), a.query ? { query: a.query } : {}, undefined, fetchImpl);
      return done(result, show.agentList(result));
    }
    case "send": return send(p, io, fetchImpl, profile);
    case "inbox": {
      const result = await runAction("inbox", profile(), pageToken(f), undefined, fetchImpl);
      return done(result, show.taskList(result, "Your inbox is empty."));
    }
    case "tasks": {
      const status = text("status");
      const result = await runAction("list", profile(), { ...(status ? { status: listState(status) } : {}), ...pageToken(f) }, undefined, fetchImpl);
      return done(result, show.taskList(result, "No tasks."));
    }
    case "get": {
      const id = fullTaskId(a.task), result = await runAction("task", profile(), { "task-id": id }, undefined, fetchImpl) as Task;
      return done(result, show.taskDetail(result), { taskId: id });
    }
    case "reply": {
      const id = fullTaskId(a.task), stateFlag = text("state");
      if (!stateFlag) throw new UsageError(`reply needs --state: ${STATES.join(", ")}.`);
      const state = taskState(stateFlag, STATES);
      const message = a.text === undefined ? undefined : await content(a.text, io);
      if (state === "TASK_STATE_INPUT_REQUIRED" && !message) throw new UsageError("input-required needs TEXT: the question you need answered.");
      const body = validatePayload("reply", { state, ...(message ? { parts: [{ text: message }] } : {}) });
      const result = await runAction("reply", profile(), { "task-id": id }, body, fetchImpl);
      return done(result, show.replied(result), { taskId: id });
    }
    case "cancel": {
      const id = fullTaskId(a.task), path = profile();
      const recipient = text("to") ?? await withProfile(path, fetchImpl, async ({ journal, client }) => {
        // Only the sender cancels: find the recipient in this profile's own send record, then the task.
        const known = Object.values(journal.load().outgoing).find(o => o.taskId === id)?.recipient;
        if (known) return known;
        const label = (await client.get(id)).metadata?.["concourse.recipient"];
        return typeof label === "string" && new RegExp(RECIPIENT_PATTERN).test(label) ? label : undefined;
      });
      if (!recipient) throw new SafeError("CANCEL_RECIPIENT_UNKNOWN", false, undefined, { taskId: id }, "Only the sender can cancel a task. If you sent it, pass --to OWNER/AGENT.");
      qualifiedRecipient(recipient);
      const result = await runAction("cancel", path, { recipient, "task-id": id }, undefined, fetchImpl) as Task;
      return done(result, show.canceled(result), { taskId: id });
    }
    case "reconcile": {
      if ([".", ".."].includes(a.message) || a.message.length > 2048) throw new UsageError("MESSAGE_ID is not a message ID.");
      const result = await runAction("reconcile-send", profile(), { "message-id": a.message }, undefined, fetchImpl);
      return done(result, show.reconciled(result));
    }
    case "pending": {
      const result = await ownerAction(profile(), "pending", undefined, fetchImpl);
      return done(result, show.pendingList(result));
    }
    case "approve": case "decline": case "retire": {
      const result = await ownerAction(profile(), p.command, a.id, fetchImpl);
      return done(result, show.admission(p.command, result));
    }
  }
  throw new UsageError("Unknown command. Run concourse help.");
}

function pageToken(f: Parsed["flags"]): Record<string, string> {
  return typeof f["page-token"] === "string" ? { "page-token": f["page-token"] } : {};
}
async function content(value: string, io: Io): Promise<string> {
  const text = value === "-" ? await (io.stdin ?? processIo().stdin!)() : value;
  if (!text.trim()) throw new UsageError("The message text is empty.");
  return text;
}
// Refuse a missing or unfinished profile before taking its lock, with the next step.
function configured(profile: string): string {
  if (!existsSync(profile)) throw new SafeError("PROFILE_NOT_FOUND", false, undefined, {}, `No profile at ${profile}. Run concourse join --agent NAME first.`);
  if (!existsSync(join(profile, "config.json"))) throw new SafeError("PROFILE_NOT_CONFIGURED", false, undefined, {}, "This profile's sign-up is unfinished. Run concourse join --agent NAME again; it resumes the same sign-up.");
  return profile;
}

async function send(p: Parsed, io: Io, fetchImpl: Fetch, profile: () => string): Promise<number> {
  const recipient = qualifiedRecipient(p.args.recipient), f = p.flags;
  if (f.timeout !== undefined && !f.wait) throw new UsageError("--timeout only applies with --wait.");
  const seconds = typeof f.timeout === "string" ? Number(f.timeout) : 120;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new UsageError("--timeout is a whole number of seconds from 1 to 3600.");
  const message = await content(p.args.text, io);
  const body = validatePayload("send", { parts: [{ text: message }], ...(typeof f.task === "string" ? { taskId: f.task } : {}), ...(typeof f.context === "string" ? { contextId: f.context } : {}) });
  const path = profile();
  const sent = await runAction("send", path, { recipient }, body, fetchImpl) as { result: unknown; messageId: string };
  const task = object(sent.result) && typeof sent.result.id === "string" && object(sent.result.status) ? sent.result as unknown as Task : undefined;
  if (!f.wait || !task) {
    io.out(p.json ? JSON.stringify({ phase: "complete", command: "send", result: sent }) : show.sent(sent, recipient));
    return EXIT.ok;
  }
  // The send succeeded. Waiting only reads; it never resends, whatever happens.
  const waited = await waitForAnswer(path, task, seconds * 1000, io, fetchImpl);
  const answered = waited.state === "answered";
  if (p.json) io.out(JSON.stringify({ phase: "complete", command: "send", result: sent, wait: { state: waited.state, task: waited.task, ...(waited.error ? { error: waited.error } : {}) } }));
  else io.out([show.sent(sent, recipient), answered ? show.taskDetail(waited.task)
    : waited.state === "timeout" ? `No answer after ${seconds} seconds. The task continues. Do not resend; check later with: concourse get ${task.id}`
    : `Reading the answer stopped${waited.error ? ` (${show.clean(waited.error)})` : ""}. The message was sent; do not resend. Check with: concourse get ${task.id}`].join("\n"));
  return answered ? EXIT.ok : EXIT.unanswered;
}
const settled = (state: string) => terminal(state) || ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"].includes(state);
async function waitForAnswer(profile: string, initial: Task, timeoutMs: number, io: Io, fetchImpl: Fetch): Promise<{ state: "answered" | "timeout" | "stopped"; task: Task; error?: string }> {
  const now = io.now ?? Date.now, deadline = now() + timeoutMs, sleep = io.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const stop = new AbortController(), interrupt = () => stop.abort(), signal = io.signal ? AbortSignal.any([io.signal, stop.signal]) : stop.signal;
  process.once("SIGINT", interrupt);
  let task = initial, pause = 1000;
  try {
    while (!settled(task.status.state)) {
      const left = deadline - now();
      if (left <= 0) return { state: "timeout", task };
      try { await sleep(Math.min(pause, left), signal); } catch { return { state: "stopped", task, error: "INTERRUPTED" }; }
      pause = Math.min(pause * 2, 10_000);
      try { task = await runAction("task", profile, { "task-id": initial.id }, undefined, fetchImpl) as Task; }
      catch (e) { return { state: "stopped", task, error: e instanceof SafeError ? e.code : "LOCAL_ERROR" }; }
    }
    return { state: "answered", task };
  } finally { process.off("SIGINT", interrupt); }
}

async function setup(p: Parsed, io: Io, fetchImpl: Fetch): Promise<number> {
  const f = p.flags, value = (name: string) => typeof f[name] === "string" ? f[name] as string : undefined;
  const agent = value("agent"), resume = f.resume === true;
  if (p.command === "join" && !handle(agent)) throw new UsageError("join needs --agent NAME: lowercase letters, digits and hyphens, at most 40 characters.");
  if (p.command === "signup" && !resume && !handle(agent)) throw new UsageError("signup needs --agent NAME, or --resume with the same --profile.");
  if (p.command === "signup" && resume && value("oauth-client-id")) throw new UsageError("--resume keeps the draft's own client; --oauth-client-id applies to a fresh signup only.");
  if (p.command === "signup" && resume && !p.profile && !agent) throw new UsageError("signup --resume needs --profile or --agent to find the draft.");
  // join and signup name their profile after the agent unless --profile says otherwise.
  const profile = p.command === "login" ? configured(resolveProfile(p.profile, io.env)) : resolveProfile(p.profile, io.env, agent);
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const deps: SetupDependencies = {
    fetchImpl, open: io.open ?? openBrowser,
    signal: io.signal ? AbortSignal.any([io.signal, controller.signal]) : controller.signal,
    ...(io.setupTimeoutMs ? { timeoutMs: io.setupTimeoutMs } : {}),
    emit: (e: SetupEvent) => io.out(p.json ? JSON.stringify("instructions" in e ? { ...e, instructions: cliText(e.instructions) } : e) : event(e)),
  };
  const noOpen = f["no-open"] === true, organization = value("organization");
  try {
    const outcome = p.command === "join" ? await joinConcourse({ agent: agent!, profile, organization, noOpen }, deps)
      : p.command === "login" ? await login({ profile, noOpen }, deps)
      : await signup({ profile, resume, noOpen, organization, agent, oauthClientId: value("oauth-client-id"), origin: value("origin") ?? (resume ? undefined : AUTOMATIC_V3_ORIGIN) }, deps);
    return outcome === "complete" ? EXIT.ok : EXIT.choose;
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}
function event(e: SetupEvent): string {
  if (e.phase === "complete") return `Ready: ${show.clean(`${e.identity.organization}/${e.identity.owner}/${e.identity.agent}`)} at ${show.clean(e.identity.origin)}\nProfile: ${dirname(e.configPath)}`;
  if (e.phase === "organization_choice") return `Choose an organization, then run the same command with --organization SLUG:\n${e.organizations.map(o => `  ${o.slug}: ${show.oneLine(o.name)}`).join("\n")}`;
  return `${cliText(e.instructions)}\n${e.actionUrl}`;
}

const RECOVERY: Record<string, string> = {
  AGENT_AWAITING_APPROVAL: "Ask an organization owner to approve this agent (on the web, or with concourse approve ID from their own agent). Then run the same join command again. Keep this profile; do not register again.",
  AGENT_DECLINED: "An organization owner declined this agent. Signing in again does not change that. Ask an owner to reconsider; after approval, run the same join command again. Keep this profile; do not register again.",
  PROFILE_IN_USE: "A running Pi session or another Concourse command is using this profile. If a Pi session uses it, this agent has already joined. Otherwise wait for the other command to finish.",
  PROFILE_BUSY_OR_LOCK_UNAVAILABLE: "A running Pi session or another Concourse command is using this profile. Wait for it to finish, or stop that session normally.",
  PROFILE_EXISTS_WITHOUT_SIGNUP: "This profile directory exists but holds no sign-up. Choose another --profile, or remove the empty directory yourself after checking it.",
  PROFILE_AGENT_CONFLICT: "This profile belongs to a different agent name. Use that name, or a different --profile.",
  PROFILE_ALREADY_CONFIGURED_USE_DOCTOR: "This profile is already signed up. Check it with concourse doctor.",
  OAUTH_EXCHANGE_UNCERTAIN: "Stop anything else using this profile, then run concourse login for it. That is a fresh sign-in with the saved client, not a retry. Keep its files; do not clear them or register again.",
  REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER: "A client registration may exist. Keep this profile as it is and do not sign up again under it.",
  HTTP_REFUSED_401: "Concourse refused this profile's sign-in. Check it with concourse doctor, then run concourse login if needed.",
};
function failed(e: unknown, json: boolean, io: Io): number {
  const safe = e instanceof SafeError ? e : undefined;
  const code = safe?.code ?? "LOCAL_ERROR", uncertain = !!safe?.uncertain;
  const ids: Record<string, string | number> = { ...(e instanceof CommandError ? e.ids : {}), ...(safe?.details ?? {}) };
  // Local errors (profile permissions, storage) carry our own fixed text, never peer content.
  const hint = RECOVERY[code.split(/[ :]/)[0]] ?? safe?.hint ?? (!safe && e instanceof Error ? e.message : undefined);
  const recovery = hint === undefined ? undefined : cliText(hint);
  if (json) io.out(JSON.stringify({ phase: "blocked", error: code, uncertain, ...ids, ...(recovery ? { recovery } : {}) }));
  else io.err(show.failure(code, ids, uncertain, recovery));
  return e instanceof UsageError || ARGUMENT_CODES.test(code) ? EXIT.usage : EXIT.failed;
}
// Shared validation refuses these before any profile, journal or network use.
const ARGUMENT_CODES = /^(FULL_TASK_ID_REQUIRED|QUALIFIED_RECIPIENT_REQUIRED|INVALID_ORGANIZATION|INVALID_IDENTIFIER|INVALID_PARTS?)\b/;
