import { test } from "node:test";
import assert from "node:assert/strict";
import { Outbox, useful } from "../src/outgoing.ts";
import { SafeError } from "../src/http.ts";
import type { Json } from "../src/types.ts";
import { answer, deferred, Memory, task } from "./helpers.ts";

function fixture() {
  const journal = new Memory(), calls: string[] = [];
  let value = task();
  const client = { send: async () => value as unknown as Json, get: async (id: string) => { calls.push(id); return value; }, network: async () => ({ accepted: true, taskId: "00000000-0000-4000-8000-000000000001" }) };
  const outbox = new Outbox(journal, client);
  return { journal, calls, client, outbox, set: (v: typeof value) => { value = v; } };
}
test("same Task with multiple continuation intents polls once and offers one durable result", async () => {
  const f = fixture(); const first = await f.outbox.send("owner/peer", [{ text: "one" }]);
  await f.outbox.send("owner/peer", [{ text: "two" }], true, "00000000-0000-4000-8000-000000000001"); f.set(answer());
  await f.outbox.sweep(); assert.deepEqual(f.calls, ["00000000-0000-4000-8000-000000000001"]); assert.equal(f.outbox.offers().length, 1);
  assert.ok(f.outbox.take(first.messageId)); const restarted = new Outbox(f.journal, f.client);
  await restarted.sweep(); assert.equal(restarted.offers().length, 0); assert.equal(restarted.take(first.messageId), undefined);
});
test("informational tasks poll genuine input-required question, suppress unrequested terminal body", async () => {
  const f = fixture(); await f.outbox.send("owner/peer", [{ text: "FYI" }], false);
  f.set(answer("question", "TASK_STATE_INPUT_REQUIRED")); await f.outbox.sweep();
  assert.equal(f.outbox.offers().length, 1); assert.ok(f.outbox.take(f.outbox.offers()[0].messageId));
  await f.outbox.sweep(); assert.equal(f.outbox.offers().length, 0);
  f.set(answer("done")); await f.outbox.sweep(); assert.equal(f.outbox.offers().length, 0);
  const count = f.calls.length; await f.outbox.sweep(); assert.equal(f.calls.length, count);
});
test("requested continuation durably promotes attention; later FYI cannot demote it", async () => {
  const f = fixture(); await f.outbox.send("owner/peer", [{ text: "FYI" }], false);
  await f.outbox.send("owner/peer", [{ text: "Need result" }], true, "00000000-0000-4000-8000-000000000001");
  await f.outbox.send("owner/peer", [{ text: "Extra info" }], false, "00000000-0000-4000-8000-000000000001");
  assert.ok(Object.values(f.journal.value.outgoing).every(o => o.expectReply));
  f.set(answer()); await new Outbox(f.journal, f.client).sweep(); assert.equal(f.outbox.offers().length, 1);
});
test("input-required then completed is two meaningful outcomes, not duplicated sender-message count", async () => {
  const f = fixture(); await f.outbox.send("owner/peer", [{ text: "request" }]);
  f.set(answer("question", "TASK_STATE_INPUT_REQUIRED")); await f.outbox.sweep(); const first = f.outbox.offers()[0]; f.outbox.take(first.messageId);
  await f.outbox.send("owner/peer", [{ text: "answer input" }], false, "00000000-0000-4000-8000-000000000001");
  f.set(answer("done")); await f.outbox.sweep(); assert.equal(f.outbox.offers().length, 1); assert.notEqual(f.outbox.offers()[0].answerKey, first.answerKey);
  f.outbox.take(f.outbox.offers()[0].messageId); await f.outbox.sweep(); assert.equal(f.outbox.offers().length, 0);
});
test("state-only updates and stale retained output cannot create useful replies", async () => {
  const f = fixture(); await f.outbox.send("owner/peer", [{ text: "request" }]);
  for (const value of [task("TASK_STATE_COMPLETED"), task("TASK_STATE_WORKING"), { ...answer(), status: { state: "TASK_STATE_COMPLETED" }, artifacts: [], history: answer().history }]) { f.set({ ...value, artifacts: [] }); await f.outbox.sweep(); assert.equal(f.outbox.offers().length, 0); }
  for (const state of ["TASK_STATE_WORKING", "TASK_STATE_SUBMITTED", "TASK_STATE_UNKNOWN"]) {
    const value = answer("stale", state); value.status.timestamp = "2026-10-12T21:00:00.000Z";
    assert.equal(useful(value), false);
  }
});
test("requested WORKING content is delivered once across polls, continuations and restart, then completion still arrives", async () => {
  const f = fixture(); const first = await f.outbox.send("owner/peer", [{ text: "request" }]);
  await f.outbox.send("owner/peer", [{ text: "clarification" }], true, "00000000-0000-4000-8000-000000000001");
  f.set(answer("confirmation", "TASK_STATE_WORKING")); await f.outbox.sweep();
  assert.equal(f.outbox.offers().length, 1); assert.ok(f.outbox.take(first.messageId));
  assert.ok(Object.values(f.journal.value.outgoing).every(o => !o.observedTerminal));
  const restarted = new Outbox(f.journal, f.client);
  await restarted.sweep(); assert.equal(restarted.offers().length, 0);
  f.set(answer("later-confirmation", "TASK_STATE_WORKING")); await restarted.sweep();
  assert.equal(restarted.offers().length, 1); assert.ok(restarted.take(first.messageId));
  f.set(answer("done")); await restarted.sweep();
  assert.equal(restarted.offers().length, 1); assert.ok(restarted.take(first.messageId));
  assert.ok(Object.values(f.journal.value.outgoing).every(o => o.observedTerminal));
});
test("current WORKING messages and artifacts qualify independently, never stale or caller content", () => {
  const message = answer("confirmation", "TASK_STATE_WORKING"); message.artifacts = [];
  assert.equal(useful(message), true);
  const artifact = answer("artifact", "TASK_STATE_WORKING"); delete artifact.status.message;
  assert.equal(useful(artifact), true);
  const caller = structuredClone(message); caller.status.message!.role = "ROLE_USER";
  assert.equal(useful(caller), false);
  const empty = structuredClone(message); empty.status.message!.parts = [{ text: "  " }];
  assert.equal(useful(empty), false);
  const stale = structuredClone(artifact); stale.status.timestamp = "2026-10-12T21:00:00.000Z";
  assert.equal(useful(stale), false);
  const unbound = structuredClone(message); delete unbound.metadata;
  assert.equal(useful(unbound), false);
});
test("expect_reply=false suppresses WORKING content but still delivers a genuine question", async () => {
  const f = fixture(); await f.outbox.send("owner/peer", [{ text: "FYI" }], false);
  f.set(answer("unrequested", "TASK_STATE_WORKING")); await f.outbox.sweep();
  assert.equal(f.outbox.offers().length, 0);
  const artifact = answer("unrequested-artifact", "TASK_STATE_WORKING"); delete artifact.status.message;
  f.set(artifact); await f.outbox.sweep(); assert.equal(f.outbox.offers().length, 0);
  f.set(answer("question", "TASK_STATE_INPUT_REQUIRED")); await f.outbox.sweep();
  assert.equal(f.outbox.offers().length, 1);
});
test("fair bounded sweep and persisted cursor survive churn and restart", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.journal.value.outgoing[`m${i}`] = { messageId: `m${i}`, recipient: "owner/peer", taskId: `00000000-0000-4000-8000-00000000000${i}`, phase: "accepted", expectReply: false };
  await f.outbox.sweep(2); assert.deepEqual(f.calls, ["00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000001"]);
  delete f.journal.value.outgoing.m1;
  await new Outbox(f.journal, f.client).sweep(2); assert.deepEqual(f.calls.slice(2), ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"]);
  await f.outbox.sweep(2); assert.equal(f.calls.at(-1), "00000000-0000-4000-8000-000000000004"); assert.equal(f.journal.value.cursors.answers, undefined);
});
test("an unfinished sent task is read every lap for an hour, then less often, then not after a week", async () => {
  const f = fixture(), hour = 60 * 60_000; let now = 0;
  const outbox = new Outbox(f.journal, f.client, () => {}, () => now);
  await outbox.send("owner/peer", [{ text: "request" }]);
  const polls = async (at: number) => { now = at; const before = f.calls.length; await outbox.sweep(); return f.calls.length - before; };
  assert.equal(await polls(0), 1); assert.equal(await polls(60_000), 1);
  // At ten hours old the task waits an hour between reads.
  assert.equal(await polls(10 * hour), 1); assert.equal(await polls(10.5 * hour), 0);
  f.set(answer("late", "TASK_STATE_WORKING")); assert.equal(await polls(11 * hour), 1);
  assert.equal(outbox.offers().length, 1, "a late answer still arrives");
  assert.equal(await polls(7 * 24 * hour), 0);
  // Our own continuation makes the task current again.
  await outbox.send("owner/peer", [{ text: "still there?" }], true, "00000000-0000-4000-8000-000000000001");
  assert.equal(await polls(7 * 24 * hour + 60_000), 1);
});
test("unknown send preserves original parts/IDs/correlation and reconciles without send retry", async () => {
  const f = fixture(); let sends = 0;
  f.client.send = async () => { sends++; throw new SafeError("TIMEOUT", true); };
  await assert.rejects(f.outbox.send("owner/peer", [{ data: { original: true } }], true, undefined, "context1"), /SEND_UNCONFIRMED/);
  const o = Object.values(f.journal.value.outgoing)[0]; assert.deepEqual(o.parts, [{ data: { original: true } }]); assert.equal(o.contextId, "context1");
  await f.outbox.reconcile(o.messageId); assert.equal(sends, 1); assert.equal(f.journal.value.outgoing[o.messageId].phase, "accepted");
});
test("known server acceptance plus local disk failure remains accepted success/do-not-resend", async () => {
  const f = fixture(); f.client.send = async () => { f.journal.fail = true; return task() as unknown as Json; };
  const result = await f.outbox.send("owner/peer", [{ text: "work" }]); assert.match(result.warning!, /Server accepted.*do not resend/); assert.equal((result.result as { id: string }).id, "00000000-0000-4000-8000-000000000001");
});
test("stale sweep cannot publish into a replacement journal", async () => {
  const f = fixture(); let alive = true; const gate = deferred<ReturnType<typeof task>>();
  f.client.get = async () => gate.promise; const guarded = new Outbox(f.journal, f.client, () => { if (!alive) throw new Error("stale"); });
  await guarded.send("owner/peer", [{ text: "request" }]); const sweep = guarded.sweep(); alive = false; const writes = f.journal.writes; gate.resolve(answer());
  await assert.rejects(sweep, /stale/); assert.equal(f.journal.writes, writes);
});
