import { test } from "node:test";
import assert from "node:assert/strict";
import { Mailbox } from "../src/delivery.ts";
import { deliveryFixture, task } from "./helpers.ts";
const details = (m: ReturnType<typeof deliveryFixture>["injected"][number]) => m.details as { taskId: string; messageIds: string[] };

test("normal mailbox hands off while busy, human input queued or a draft exists, without reading those states", () => {
  const f = deliveryFixture();
  for (const k of ["idle", "pending", "draft"]) Object.defineProperty(f.boundary, k, { get() { throw new Error("Pi scheduling must remain native"); } });
  f.delivery.enqueue(task()); f.delivery.flush();
  assert.equal(f.injected.length, 1); assert.match(f.injected[0].content as string, /A2A message from/);
  assert.equal(Object.values(f.journal.value.batches)[0].phase, "handed-off");
});

test("duplicate reads/hints do not offer the same caller IDs twice; every WORKING continuation remains eligible", () => {
  const f = deliveryFixture();
  f.delivery.enqueue(task()); f.delivery.flush();
  assert.equal(f.delivery.enqueue(task()), undefined); f.delivery.flush(); assert.equal(f.injected.length, 1);
  f.delivery.enqueue(task("TASK_STATE_WORKING", ["m1", "m2"])); f.delivery.flush();
  assert.equal(f.injected.length, 2); assert.deepEqual(details(f.injected[1]).messageIds, ["m2"]);
  assert.equal(f.journal.value.batches[Object.keys(f.journal.value.batches)[1]].phase, "handed-off");
});

test("several Tasks can queue independently without execution ownership or settlement", () => {
  const f = deliveryFixture();
  f.delivery.enqueue(task()); f.delivery.enqueue({ ...task("TASK_STATE_WORKING", ["m2"]), id: "00000000-0000-4000-8000-000000000002" }); f.delivery.flush();
  assert.equal(f.injected.length, 2); assert.deepEqual(f.injected.map(m => details(m).taskId), ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
});

test("input artifacts, causal IDs and authenticated caller labeling survive a hand-off", () => {
  const f = deliveryFixture(); f.delivery.enqueue(task()); f.delivery.flush();
  const body = f.injected[0].content as string;
  assert.match(body, /context1/); assert.match(body, /sender/); assert.match(body, /in1/); assert.match(body, /no acknowledgement needed/);
  assert.deepEqual(details(f.injected[0]).messageIds, ["m1"]);
});

test("restart does not replay a possible hand-off, nor block unrelated new mail", () => {
  const f = deliveryFixture(); const b = f.delivery.enqueue(task())!;
  f.journal.value.batches[b.id].phase = "uncertain";
  const m = new Mailbox(f.journal, f.boundary, "session1"); m.recover(); m.flush(); assert.equal(f.injected.length, 0);
  m.enqueue({ ...task("TASK_STATE_WORKING", ["m2"]), id: "00000000-0000-4000-8000-000000000002" }); m.flush();
  assert.equal(f.injected.length, 1); assert.equal(details(f.injected[0]).taskId, "00000000-0000-4000-8000-000000000002");
});

test("provably uninjected same-session queue survives restart with original IDs", () => {
  const f = deliveryFixture(); const b = f.delivery.enqueue(task())!;
  const m = new Mailbox(f.journal, f.boundary, "session1"); m.recover(); m.flush(); m.flush();
  assert.equal(f.injected.length, 1); assert.deepEqual(details(f.injected[0]).messageIds, b.messageIds);
});

test("new consumer/session cannot inject old-session queued mail", () => {
  const f = deliveryFixture(); f.delivery.enqueue(task()); f.state.sessionId = "replacement";
  assert.throws(() => f.delivery.flush(), /SESSION_REPLACED/);
  const m = new Mailbox(f.journal, f.boundary, "replacement"); m.recover(); m.flush(); assert.equal(f.injected.length, 0);
  m.enqueue({ ...task("TASK_STATE_WORKING", ["m2"]), id: "00000000-0000-4000-8000-000000000002" }); m.flush(); assert.equal(f.injected.length, 1);
});

test("write failure before hand-off cannot inject, and uncertain injection never retries automatically", () => {
  const f = deliveryFixture(); f.delivery.enqueue(task()); f.journal.fail = true;
  assert.throws(() => f.delivery.flush(), /disk failure/); assert.equal(f.injected.length, 0);
  f.journal.fail = false; f.boundary.inject = () => { throw new Error("uncertain Pi call"); };
  assert.throws(() => f.delivery.flush(), /uncertain Pi/);
  f.boundary.inject = m => f.injected.push(m); f.delivery.flush(); assert.equal(f.injected.length, 0);
});

test("replacement at the hand-off boundary does not save through old ownership", () => {
  const f = deliveryFixture(); f.delivery.enqueue(task());
  f.boundary.inject = m => { f.injected.push(m); f.state.sessionId = "replacement"; };
  assert.throws(() => f.delivery.flush(), /SESSION_REPLACED/);
  assert.equal(Object.values(f.journal.value.batches)[0].phase, "uncertain"); assert.equal(f.injected.length, 1);
});

test("terminal correspondence does not create a new prompt or cancel anything in Pi", () => {
  const f = deliveryFixture(); assert.equal(f.delivery.enqueue(task("TASK_STATE_CANCELED")), undefined);
  f.delivery.enqueue({ ...task(), id: "other" }); f.delivery.flush(); assert.equal(f.injected.length, 1);
});

test("each bounded hand-off keeps all remaining message IDs eligible for later reads", () => {
  const f = deliveryFixture(), value = task("TASK_STATE_WORKING", Array.from({ length: 101 }, (_, i) => `m${i}`));
  f.delivery.enqueue(value); f.delivery.flush(); f.delivery.enqueue(value); f.delivery.flush();
  assert.deepEqual(f.injected.map(m => details(m).messageIds.length), [100, 1]);
  assert.equal(f.delivery.enqueue(value), undefined);
});

test("duplicate IDs and a single oversized message fail before hand-off", () => {
  const f = deliveryFixture(); assert.throws(() => f.delivery.enqueue(task("TASK_STATE_WORKING", ["m1", "m1"])), /DUPLICATE_CALLER_IDS/);
  const value = task(); value.history![0].parts = [{ text: "x".repeat(300000) }];
  assert.throws(() => f.delivery.enqueue(value), /DELIVERY_MESSAGE_LIMIT/); assert.equal(f.injected.length, 0);
});
