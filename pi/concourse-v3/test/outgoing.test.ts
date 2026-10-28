import { test } from "node:test";
import assert from "node:assert/strict";
import { Outbox, useful } from "../src/outgoing.ts";
import { SafeError } from "../src/http.ts";
import type { Json } from "../src/types.ts";
import { answer, deferred, Memory, task } from "./helpers.ts";

function fixture() {
  const journal = new Memory(), calls: string[] = [];
  let value = task();
  const client = { send: async () => value as unknown as Json, get: async (id: string) => { calls.push(id); return value; }, network: async () => ({ accepted: true, taskId: "task1" }) };
  const outbox = new Outbox(journal, client);
  return { journal, calls, client, outbox, set: (v: typeof value) => { value = v; } };
}
test("same Task with multiple continuation intents polls once and offers one durable result", async () => {
  const f = fixture(); const first = await f.outbox.send("owner/peer", [{ text: "one" }]);
  await f.outbox.send("owner/peer", [{ text: "two" }], true, "task1"); f.set(answer());
  await f.outbox.sweep(); assert.deepEqual(f.calls, ["task1"]); assert.equal(f.outbox.offers().length, 1);
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
  await f.outbox.send("owner/peer", [{ text: "Need result" }], true, "task1");
  await f.outbox.send("owner/peer", [{ text: "Extra info" }], false, "task1");
  assert.ok(Object.values(f.journal.value.outgoing).every(o => o.expectReply));
  f.set(answer()); await new Outbox(f.journal, f.client).sweep(); assert.equal(f.outbox.offers().length, 1);
});
test("input-required then completed is two meaningful outcomes, not duplicated sender-message count", async () => {
  const f = fixture(); await f.outbox.send("owner/peer", [{ text: "request" }]);
  f.set(answer("question", "TASK_STATE_INPUT_REQUIRED")); await f.outbox.sweep(); const first = f.outbox.offers()[0]; f.outbox.take(first.messageId);
  await f.outbox.send("owner/peer", [{ text: "answer input" }], false, "task1");
  f.set(answer("done")); await f.outbox.sweep(); assert.equal(f.outbox.offers().length, 1); assert.notEqual(f.outbox.offers()[0].answerKey, first.answerKey);
  f.outbox.take(f.outbox.offers()[0].messageId); await f.outbox.sweep(); assert.equal(f.outbox.offers().length, 0);
});
test("state-only/progress/receipt cannot resurrect history or create useful replies", async () => {
  const f = fixture(); await f.outbox.send("owner/peer", [{ text: "request" }]);
  for (const value of [task("TASK_STATE_COMPLETED"), task("TASK_STATE_WORKING"), { ...answer(), status: { state: "TASK_STATE_COMPLETED" }, artifacts: [], history: answer().history }]) { f.set({ ...value, artifacts: [] }); await f.outbox.sweep(); assert.equal(f.outbox.offers().length, 0); }
  assert.equal(useful({ ...answer(), status: { ...answer().status, state: "TASK_STATE_WORKING" } }), false);
});
test("fair bounded sweep and persisted cursor survive churn and restart", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.journal.value.outgoing[`m${i}`] = { messageId: `m${i}`, recipient: "owner/peer", taskId: `task${i}`, phase: "accepted", expectReply: false };
  await f.outbox.sweep(2); assert.deepEqual(f.calls, ["task0", "task1"]);
  delete f.journal.value.outgoing.m1;
  await new Outbox(f.journal, f.client).sweep(2); assert.deepEqual(f.calls.slice(2), ["task2", "task3"]);
  await f.outbox.sweep(2); assert.equal(f.calls.at(-1), "task4"); assert.equal(f.journal.value.cursors.answers, undefined);
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
  const result = await f.outbox.send("owner/peer", [{ text: "work" }]); assert.match(result.warning!, /Server accepted.*do not resend/); assert.equal((result.result as { id: string }).id, "task1");
});
test("stale sweep cannot publish into a replacement journal", async () => {
  const f = fixture(); let alive = true; const gate = deferred<ReturnType<typeof task>>();
  f.client.get = async () => gate.promise; const guarded = new Outbox(f.journal, f.client, () => { if (!alive) throw new Error("stale"); });
  await guarded.send("owner/peer", [{ text: "request" }]); const sweep = guarded.sweep(); alive = false; const writes = f.journal.writes; gate.resolve(answer());
  await assert.rejects(sweep, /stale/); assert.equal(f.journal.writes, writes);
});
