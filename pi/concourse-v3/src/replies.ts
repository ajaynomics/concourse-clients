import { randomUUID } from "node:crypto";
import { validOutcome, type Client } from "./client.ts";
import type { Journal } from "./storage.ts";
import { SafeError } from "./http.ts";
import type { Outcome, ReplyIntent, Task } from "./types.ts";

// Recipient replies by Task ID. The exact payload is journaled before the PATCH so an
// unconfirmed write can be inspected; it is never replayed automatically.
export class Replies {
  constructor(private journal: Journal, private client: Pick<Client, "reply">, private guard: () => void = () => {}) {}
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
      if (refused) throw new SafeError(`REPLY_REFUSED status=${(e as SafeError).status} replyId=${id}; the Task was not changed`);
      throw new SafeError(`REPLY_UNCONFIRMED replyId=${id}; read the original Task before retrying`, true);
    }
    // Known acceptance remains success if bookkeeping fails, including generation replacement.
    try { this.guard(); this.record(id, "accepted"); return result; }
    catch { return { task: result, warning: "Server accepted; local save failed. Do not repeat the reply." }; }
  }
  private record(id: string, phase: ReplyIntent["phase"]): void {
    const l = this.journal.load(); l.replies![id].phase = phase; this.journal.save(l);
  }
}
