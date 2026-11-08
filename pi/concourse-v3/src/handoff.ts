import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
type CustomMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
interface Seen { role: string; customType?: string; content?: unknown; details?: unknown }

export const DUPLICATE_NOTICE = "(Concourse: this message was already added to the conversation after an interrupted turn. Nothing new.)";

// Pi 1.4.0 keeps a custom follow-up sent during a run only in its agent queue. Escape and
// dequeue clear that queue but restore only typed text, so handed-off mail could vanish.
// Each hand-off stays in memory until Pi's message_end shows it entered the conversation
// (Pi appends the session entry right after that event). A settled run that never consumed
// a hand-off gets it back without a new turn: the person stopped the agent on purpose.
// A restart still loses an unconsumed hand-off, as before. Content is never written to
// disk, and the ledger's handed-off phase stays final.
export class Handoffs {
  private pending: { key: string; message: CustomMessage; queued: boolean; starts: number }[] = [];
  private kept = new Set<string>();
  private starts = 0;
  constructor(private pi: ExtensionAPI, private types: readonly string[]) {}

  // busy: Pi is mid-run (isIdle false), so this mail waits in Pi's follow-up queue. That holds
  // after agent_end too, through retry backoff, compaction and settling hooks.
  send(message: CustomMessage, busy: boolean): void {
    const entry = { key: key(message), message, queued: busy, starts: this.starts };
    this.pending.push(entry);
    try { this.pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" }); }
    catch (e) { this.pending.splice(this.pending.indexOf(entry), 1); throw e; }
  }

  // Returns a replacement only for an original that surfaces after its copy was put back.
  // That happens when an abort left Pi's queue intact (SDK/RPC abort, /compact).
  consumed<M extends Seen>(message: M): M | undefined {
    if (message.role !== "custom" || !this.types.includes(message.customType ?? "")) return;
    const k = key(message), i = this.pending.findIndex(p => p.key === k);
    if (i >= 0) { this.pending.splice(i, 1); return; }
    if (!this.kept.delete(k)) return;
    return { ...message, content: DUPLICATE_NOTICE, details: { ...(message.details as object), duplicate: true } };
  }

  // Mail sent while idle starts a run of its own; one deferred by prompt preparation can land
  // in a later run's queue instead, which agent_start reveals.
  started(): void { this.starts++; }

  // A run settled. Every unconsumed hand-off that waited in its queue is put back. Mail sent
  // while Pi emits agent_settled is idle-sent and deferred to its own run, so it stays out.
  settled(aborted: boolean, ctx: ExtensionContext): void {
    const isLost = (p: { queued: boolean; starts: number }) => p.queued || p.starts < this.starts;
    const lost = this.pending.filter(isLost);
    if (!lost.length) return;
    this.pending = this.pending.filter(p => !isLost(p));
    for (const p of lost) {
      this.kept.add(p.key);
      // Not streaming during agent_settled, so Pi appends this entry now and starts no turn.
      // The changed details keep the copy from matching its original in consumed().
      this.pi.sendMessage({ ...p.message, details: { ...(p.message.details as object), held: true } }, { triggerTurn: false });
    }
    while (this.kept.size > 1000) this.kept.delete(this.kept.values().next().value!);
    ctx.ui.notify(`Concourse mail held after ${aborted ? "Escape" : "Pi's queue was cleared"}: ${lost.length} message(s), included with your next message`, "info");
  }

  // A replaced or closed session's queue is gone with it.
  reset(): void { this.pending = []; this.kept.clear(); this.starts = 0; }
}

function key(m: Seen | CustomMessage): string {
  return createHash("sha256").update(JSON.stringify([m.customType, m.details ?? null, m.content ?? []])).digest("hex");
}
