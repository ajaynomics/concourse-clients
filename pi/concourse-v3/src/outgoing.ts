import { createHash, randomUUID } from "node:crypto";
import { qualifiedRecipient, wireParts, type Client } from "./client.ts";
import type { Journal } from "./storage.ts";
import { object, terminal, type Json, type ObjectValue, type Outgoing, type Task, type Ledger } from "./types.ts";
import { SafeError } from "./http.ts";
import { taskOutput } from "./output.ts";
export class Outbox {
  constructor(private journal: Journal, private client: Pick<Client, "send" | "get" | "network">, private guard: () => void = () => {}) {}
  private observation(l: Ledger, taskId: string): number { return l.observations?.[taskId] ?? 0; }
  private advanceObservation(l: Ledger, taskId: string): void {
    l.observations ??= {};
    l.observations[taskId] = this.observation(l, taskId) + 1;
  }
  private retireQuestions(l: Ledger, keys: string[]): void {
    if (!keys.length) return;
    l.retiredQuestions ??= {};
    for (const key of keys) l.retiredQuestions[key] = true;
  }
  private storeAnswer(l: Ledger, o: Outgoing, value: Json): void {
    if (object(value) && typeof value.id === "string" && object(value.status)) {
      const currentQuestion = inputRequired(value) ? answerKey(value) : undefined;
      const stale = Object.values(l.outgoing).filter(v => v.taskId === value.id && inputRequired(v.answer) && v.answerKey && v.answerKey !== currentQuestion);
      this.retireQuestions(l, stale.map(v => v.answerKey!));
    }
    if ((!o.expectReply && !inputRequired(value)) || !useful(value)) return;
    const key = answerKey(value);
    if (l.seenAnswers[key] || l.retiredQuestions?.[key]) return;
    o.answer = value;
    if (o.answerKey !== key) { o.offered = false; o.delivered = false; }
    o.answerKey = key;
  }
  async send(recipient: string, parts: ObjectValue[], expectReply = true, taskId?: string, contextId?: string): Promise<{ result: Json; messageId: string; warning?: string }> {
    this.guard(); qualifiedRecipient(recipient); wireParts(parts);
    const l = this.journal.load(), id = randomUUID();
    const intent: Outgoing = { messageId: id, recipient, parts: structuredClone(parts), contextId, expectReply: expectReply || (!!taskId && Object.values(l.outgoing).some(o => o.taskId === taskId && o.expectReply)), phase: "prepared", taskId };
    // Capture only questions known before this continuation. Acceptance cannot retire a later fresh question.
    if (taskId) intent.supersedesQuestions = [...new Set(Object.values(l.outgoing).filter(o => o.taskId === taskId && inputRequired(o.answer) && o.answerKey).map(o => o.answerKey!))];
    l.outgoing[id] = intent; this.journal.save(l);
    let result: Json;
    try { result = await this.client.send(recipient, id, parts, taskId, contextId); }
    catch (e) {
      this.guard(); const latest = this.journal.load();
      // An HTTP 4xx is a definite refusal. Anything else, including SESSION_REPLACED after a POST, stays uncertain.
      const refused = e instanceof SafeError && !e.uncertain && !!e.status && e.status < 500;
      latest.outgoing[id]!.phase = refused ? "refused" : "uncertain"; this.journal.save(latest);
      if (refused) throw new SafeError(`SEND_REFUSED status=${(e as SafeError).status} messageId=${id}; nothing was delivered`);
      throw new SafeError(`SEND_UNCONFIRMED_OR_REFUSED messageId=${id}`, true);
    }
    // Known acceptance remains success if bookkeeping fails, including generation replacement.
    try {
      this.guard(); const latest = this.journal.load(), saved = latest.outgoing[id]!;
      saved.phase = "accepted";
      if (object(result) && typeof result.id === "string") { saved.taskId = result.id; saved.resultType = "task"; }
      else if (object(result) && typeof result.messageId === "string") saved.resultType = "message";
      if (saved.taskId) for (const o of Object.values(latest.outgoing)) if (o.taskId === saved.taskId) { if (saved.expectReply) o.expectReply = true; o.observedTerminal = false; }
      if (taskId && (saved.taskId === taskId || saved.resultType === "message")) this.retireQuestions(latest, saved.supersedesQuestions ?? []);
      // A late snapshot must not reverse newer known caller acceptance, even when no old question was cached.
      if (saved.resultType !== "task" || this.observation(l, saved.taskId!) === this.observation(latest, saved.taskId!)) this.storeAnswer(latest, saved, result);
      if (saved.taskId) this.advanceObservation(latest, saved.taskId);
      this.journal.save(latest);
      return { result, messageId: id };
    } catch { return { result, messageId: id, warning: "Server accepted; local intent save failed. Retain returned task/message ID; do not resend." }; }
  }
  async reconcile(messageId: string): Promise<void> {
    this.guard(); const o = this.journal.load().outgoing[messageId];
    if (!o || !["prepared", "uncertain"].includes(o.phase)) throw new SafeError("NO_UNCERTAIN_SEND");
    const receipt = await this.client.network({ operation: "delivery", recipient: o.recipient, messageId }); this.guard();
    if (!object(receipt) || receipt.accepted !== true) throw new SafeError("SEND_RECEIPT_UNRESOLVED", true);
    const direct = receipt.resultType === "message" && receipt.state === "delivered" && receipt.taskStatus === null && receipt.taskId === undefined;
    if (!direct && typeof receipt.taskId !== "string") throw new SafeError("SEND_RECEIPT_UNRESOLVED", true);
    const l = this.journal.load(), fresh = l.outgoing[messageId]!;
    fresh.phase = "accepted";
    if (direct) {
      // Acceptance is known, not the lost response body. Keep the original intent without a fabricated answer/Task.
      fresh.directResultUnavailable = true; fresh.resultType = "message";
    } else {
      fresh.taskId = receipt.taskId as string; fresh.resultType = "task";
      const expected = fresh.expectReply || Object.values(l.outgoing).some(v => v.taskId === fresh.taskId && v.expectReply);
      for (const v of Object.values(l.outgoing)) if (v.taskId === fresh.taskId) { v.expectReply = expected; v.observedTerminal = false; }
    }
    if (o.taskId && (direct || fresh.taskId === o.taskId)) this.retireQuestions(l, fresh.supersedesQuestions ?? []);
    if (fresh.taskId) this.advanceObservation(l, fresh.taskId);
    this.journal.save(l);
  }
  async sweep(max = 20): Promise<void> {
    this.guard(); const l = this.journal.load();
    const byTask = new Map<string, Outgoing>();
    for (const o of Object.values(l.outgoing)) if (o.phase === "accepted" && o.resultType !== "message" && o.taskId && !o.observedTerminal && !byTask.has(o.taskId)) byTask.set(o.taskId, o);
    const tasks = [...byTask.keys()].sort();
    const after = l.cursors.answers;
    const start = after ? tasks.findIndex(id => id > after) : 0;
    const page = start < 0 ? [] : tasks.slice(start, start + max);
    for (const taskId of page) {
      const before = this.observation(this.journal.load(), taskId);
      let value: Task | undefined, blocked: string | undefined;
      try { value = await this.client.get(taskId); } catch (e) {
        this.guard();
        if (e instanceof SafeError && e.code === "RESPONSE_TOO_LARGE" && !e.uncertain) blocked = "RESPONSE_TOO_LARGE";
        else if (taskLocalRefusal(e)) { if (e.status !== 404) blocked = `HTTP_${e.status}`; }
        else throw e;
        // Neither missing, refused nor oversized content is completion. Retain intent and retry in a later bounded sweep.
      }
      this.guard();
      const fresh = this.journal.load(), saved = fresh.outgoing[byTask.get(taskId)!.messageId];
      if (before === this.observation(fresh, taskId)) {
        if (value) {
          // Other completed reads or known caller acceptance fence earlier in-flight responses.
          delete fresh.blockedAnswers?.[taskId];
          this.advanceObservation(fresh, taskId);
          if (saved) this.storeAnswer(fresh, saved, value as unknown as Json);
          if (terminal(value.status.state)) for (const o of Object.values(fresh.outgoing)) if (o.taskId === taskId) o.observedTerminal = true;
        } else if (blocked) {
          fresh.blockedAnswers ??= {};
          fresh.blockedAnswers[taskId] = { code: blocked };
        }
      }
      fresh.cursors.answers = taskId; this.journal.save(fresh);
    }
    if (start < 0 || start + page.length >= tasks.length) { this.guard(); const fresh = this.journal.load(); delete fresh.cursors.answers; this.journal.save(fresh); }
  }
  offers(): Outgoing[] {
    this.guard(); const l = this.journal.load(), keys = new Set<string>();
    return Object.values(l.outgoing).filter(o => {
      if (!pending(l, o) || keys.has(o.answerKey!)) return false;
      keys.add(o.answerKey!); return true;
    });
  }
  markOffered(id: string): void { this.guard(); const l = this.journal.load(); if (l.outgoing[id]) l.outgoing[id].offered = true; this.journal.save(l); }
  take(id: string): Json | undefined {
    this.guard(); const l = this.journal.load(), o = l.outgoing[id];
    if (!o || !pending(l, o)) return;
    // At-most-once local attempt, durable across intents, continuations and restarts.
    // The seenAnswers fence remains; the delivered body is dropped to keep the ledger bounded.
    const value = o.answer; l.seenAnswers[o.answerKey!] = true; o.delivered = true; delete o.answer; this.journal.save(l); return value;
  }
}
function pending(l: Ledger, o: Outgoing): boolean {
  return (o.expectReply || inputRequired(o.answer)) && !!o.answer && !o.delivered && !!o.answerKey && !l.seenAnswers[o.answerKey] && !l.retiredQuestions?.[o.answerKey];
}
// One Task's refusal must not starve later answers. Authentication, membership, rate and
// service-wide failures still stop the sweep so they surface instead of being skipped.
function taskLocalRefusal(e: unknown): e is SafeError {
  return e instanceof SafeError && e.code === "HTTP_REFUSED" && !e.uncertain && !!e.status && ![401, 403, 429, 503].includes(e.status);
}
export function answerKey(value: Json): string {
  const v = value as unknown as Task;
  const content = object(value) && value.role === "ROLE_AGENT" ? value : { taskId: v.id, state: v.status?.state, message: v.status?.message, artifacts: v.artifacts };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
export function inputRequired(value: unknown): boolean { return object(value) && object(value.status) && value.status.state === "TASK_STATE_INPUT_REQUIRED" && useful(value); }
export function useful(value: unknown): boolean {
  if (!object(value)) return false;
  const content = (m: unknown): boolean => object(m) && Array.isArray(m.parts) && m.parts.some(p => object(p) && ((typeof p.text === "string" && !!p.text.trim()) || object(p.data) || object(p.file) || (typeof p.url === "string" && !!p.url) || (typeof p.raw === "string" && !!p.raw)));
  if (value.role === "ROLE_AGENT") return content(value);
  const t = value as unknown as Task;
  if (!t.status || (!terminal(t.status.state) && t.status.state !== "TASK_STATE_INPUT_REQUIRED")) return false;
  const output = taskOutput(t);
  return content(output.message) || output.artifacts.some(content);
}
