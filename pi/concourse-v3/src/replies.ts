import { randomUUID } from "node:crypto";
import { TASK_FINISHED_HINT, validOutcome, type Client } from "./client.ts";
import type { Journal } from "./storage.ts";
import { SafeError } from "./http.ts";
import { terminal, type Outcome, type ReplyIntent, type Task } from "./types.ts";

// Recipient replies by Task ID. The exact payload is journaled before the PATCH so an
// unconfirmed write can be inspected; it is never replayed automatically.
export class Replies {
  constructor(private journal: Journal, private client: Pick<Client, "reply"> & Partial<Pick<Client, "get">>, private guard: () => void = () => {}) {}
  async send(taskId: string, outcome: Outcome): Promise<Task | { task: Task; warning: string }> {
    this.guard(); validOutcome(outcome);
    const id = randomUUID(), l = this.journal.load();
    l.replies ??= {}; l.replies[id] = { id, taskId, outcome: structuredClone(outcome), phase: "prepared" }; this.journal.save(l);
    let result: Task;
    try { result = await this.client.reply(taskId, outcome, this.guard); }
    catch (e) {
      this.guard();
      const refused = e instanceof SafeError && !e.uncertain && !!e.status && e.status < 500;
      this.record(id, refused ? "refused" : "uncertain");
      if (!refused) throw new SafeError(`REPLY_UNCONFIRMED replyId=${id}; read the original Task before retrying`, true);
      const status = (e as SafeError).status!;
      // The worker API hides why a write was refused. Nothing changed, so a read is safe.
      if (await this.finished(taskId)) throw new SafeError("TASK_ALREADY_FINISHED", false, status, { replyId: id, status }, TASK_FINISHED_HINT);
      throw new SafeError("REPLY_REFUSED", false, status, { replyId: id, status }, "The task was not changed. Check the task ID and reply state before replying again.");
    }
    // Known acceptance remains success if bookkeeping fails, including generation replacement.
    try { this.guard(); this.record(id, "accepted"); return result; }
    catch { return { task: result, warning: "Server accepted; local save failed. Do not repeat the reply." }; }
  }
  private async finished(taskId: string): Promise<boolean> {
    try { const t = await this.client.get?.(taskId); this.guard(); return !!t && terminal(t.status.state); } catch { return false; }
  }
  private record(id: string, phase: ReplyIntent["phase"]): void {
    const l = this.journal.load(); l.replies![id].phase = phase; this.journal.save(l);
  }
}
