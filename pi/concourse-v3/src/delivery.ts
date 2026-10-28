import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Journal } from "./storage.ts";
import { SafeError } from "./http.ts";
import { terminal, type Batch, type Task } from "./types.ts";
import { incoming } from "./format.ts";
type CustomMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
export const DELIVERY_TYPE = "concourse-v3.delivery";
export interface Boundary { sessionId(): string; inject(message: CustomMessage): void }

// Mailbox bookkeeping only. Pi owns its human/peer queues, execution and interruption.
export class Mailbox {
  constructor(private journal: Journal, private boundary: Boundary, readonly sessionId: string, private guard: () => void = () => {}) {}
  private current(): void { this.guard(); if (this.boundary.sessionId() !== this.sessionId) throw new SafeError("SESSION_REPLACED"); }
  recover(): void {
    this.current(); const l = this.journal.load();
    for (const b of Object.values(l.batches)) {
      // A crash may have handed the message to Pi. Never replay a prompt or gate newer mail on it.
      if (b.phase !== "queued" && !["settled", "canceled", "handed-off"].includes(b.phase)) b.phase = "uncertain";
      if (b.phase === "handed-off") { delete b.messages; delete b.artifacts; }
    }
    for (const o of Object.values(l.outgoing)) if (o.phase === "prepared") o.phase = "uncertain";
    for (const o of Object.values(l.replies ?? {})) if (o.phase === "prepared") o.phase = "uncertain";
    this.journal.save(l);
  }
  enqueue(t: Task): Batch | undefined {
    this.current(); if (terminal(t.status.state)) return;
    const l = this.journal.load();
    const seen = new Set(Object.values(l.batches).filter(b => b.taskId === t.id).flatMap(b => b.messageIds));
    const messages = (t.history ?? []).filter(m => m.role === "ROLE_USER" && m.messageId && !seen.has(m.messageId));
    if (!messages.length && t.status.message?.role === "ROLE_USER" && !seen.has(t.status.message.messageId)) messages.push(t.status.message);
    const selected = messages.slice(0, 100);
    while (selected.length && Buffer.byteLength(JSON.stringify(selected)) > 256 * 1024) selected.pop();
    if (!selected.length) { if (messages.length) throw new SafeError("DELIVERY_MESSAGE_LIMIT"); return; }
    const ids = selected.map(m => m.messageId);
    if (new Set(ids).size !== ids.length) throw new SafeError("DUPLICATE_CALLER_IDS");
    const b: Batch = { id: randomUUID(), taskId: t.id, sessionId: this.sessionId, messageIds: ids, messages: structuredClone(selected), artifacts: structuredClone(t.artifacts ?? []), contextId: t.contextId, caller: t.metadata?.["concourse.caller"] ?? null, phase: "queued" };
    l.batches[b.id] = b; this.journal.save(l); return b;
  }
  flush(): void {
    this.current();
    const queued = Object.values(this.journal.load().batches).filter(b => b.sessionId === this.sessionId && b.phase === "queued").map(b => b.id);
    for (const id of queued) {
      this.current(); const l = this.journal.load(), b = l.batches[id];
      if (!b || b.sessionId !== this.sessionId || b.phase !== "queued") continue;
      // Persist the at-most-once local hand-off attempt before using Pi's ordinary follow-up API.
      b.phase = "uncertain"; this.journal.save(l);
      this.boundary.inject({ customType: DELIVERY_TYPE, display: true, details: { taskId: b.taskId, messageIds: b.messageIds, sessionId: b.sessionId }, content: incoming({ ...b, messages: b.messages ?? [] }) });
      // The ledger is bounded: after hand-off only the IDs are kept, as dedupe fences.
      this.current(); b.phase = "handed-off"; delete b.messages; delete b.artifacts; this.journal.save(l);
    }
  }
}
