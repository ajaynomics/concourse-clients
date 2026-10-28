import assert from "node:assert/strict";
import test from "node:test";
import { nativeFixture, bounded, toolCall } from "./sdk-native-fixture-20261012.ts";
import { deferred } from "./sdk-seams-fixture-20261012.ts";
import { PrivateFiles } from "../src/storage.ts";

test("real Pi SDK automatically offers peer mail; model turn end neither claims nor completes a Task", { timeout: 10000 }, async t => {
  const entered = deferred<void>(), hold = deferred<void>();
  const f = await nativeFixture(() => { entered.resolve(); return { text: "No explicit reply", gate: hold }; });
  t.after(() => f.cleanup()); await bounded(entered.promise);
  assert.equal(Object.values(f.journal.load().batches)[0].phase, "handed-off");
  assert.equal(f.server.current.status.state, "TASK_STATE_SUBMITTED"); assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0);
  assert.match(JSON.stringify(f.contexts), /A2A message from/); hold.resolve(); await bounded(f.session.waitForIdle());
  assert.equal(f.server.current.status.state, "TASK_STATE_SUBMITTED"); assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0);
  assert.equal(f.aborted, 0); assert.deepEqual(f.errors, []);
});

test("real Pi SDK ordinary task-ID reply preserves explicit atomic artifacts with no delivery envelope", { timeout: 10000 }, async t => {
  const f = await nativeFixture((_context, index) => !index ? { calls: [toolCall("concourse_v3_reply", { task_id: "task1", state: "TASK_STATE_COMPLETED", parts: [{ text: "Meaningful requested output" }], artifacts: [{ name: "Output", parts: [{ data: { value: 7 } }] }] })] } : { text: "Output published" });
  t.after(() => f.cleanup()); await bounded(f.session.waitForIdle());
  assert.equal(f.server.current.status.state, "TASK_STATE_COMPLETED");
  const reports = f.server.calls.filter(c => c.method === "PATCH"); assert.equal(reports.length, 1);
  assert.equal(reports[0].body.delivery, undefined); assert.equal(reports[0].body.message.parts[0].text, "Meaningful requested output");
  assert.deepEqual(reports[0].body.artifacts[0].parts[0].data, { value: 7 });
  assert.equal(Object.values(f.journal.load().replies!)[0].phase, "accepted");
  assert.match(JSON.stringify(f.contexts.at(-1)), /TASK_STATE_COMPLETED/); assert.deepEqual(f.errors, []);
});

test("real SDK read tools expose useful JSON, not a transport receipt", { timeout: 10000 }, async t => {
  const f = await nativeFixture((_context, index) => !index ? { calls: [toolCall("concourse_v3_find", {}), toolCall("concourse_v3_get", { task_id: "task1" }, "get")] } : { text: "Read finished" }, { inboxEmpty: true });
  t.after(() => f.cleanup()); await bounded(f.session.prompt("Read current correspondence"));
  assert.match(JSON.stringify(f.contexts.at(-1)), /Decisive synthetic directory content/);
  assert.match(JSON.stringify(f.contexts.at(-1)), /Untrusted fixture/); assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0);
  assert.deepEqual(f.errors, []);
});

test("a later human turn can still explicitly reply to an earlier received Task", { timeout: 10000 }, async t => {
  const f = await nativeFixture((_context, index) => index === 1 ? { calls: [toolCall("concourse_v3_reply", { task_id: "task1", state: "TASK_STATE_WORKING", parts: [{ text: "Reply after human intervention" }] })] } : { text: "Ordinary conversation" });
  t.after(() => f.cleanup()); await bounded(f.session.waitForIdle());
  await bounded(f.session.prompt("Human intervenes in the same conversation"));
  assert.equal(f.server.current.status.state, "TASK_STATE_WORKING"); assert.match(JSON.stringify(f.server.current.history), /Reply after human intervention/);
  assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 1); assert.equal(f.aborted, 0); assert.deepEqual(f.errors, []);
});

test("shutdown drains old reply I/O before lock release; late accepted response cannot save through replaced ownership", { timeout: 10000 }, async t => {
  const f = await nativeFixture((_context, index) => !index ? { calls: [toolCall("concourse_v3_reply", { task_id: "task1", state: "TASK_STATE_COMPLETED", parts: [{ text: "Requested reply" }] })] } : { text: "No replay" }, { inboxEmpty: true });
  t.after(() => f.cleanup()); const hold = f.server.hold("reply");
  const work = f.session.prompt("Publish explicit reply"); await bounded(f.server.signal("reply").promise);
  const closed = f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  const challenger = new PrivateFiles(f.root); t.after(() => challenger.close());
  assert.throws(() => challenger.acquire(), /consumer already owned/);
  assert.equal(Object.values(f.journal.load().replies!)[0].phase, "prepared");
  hold.resolve(); await bounded(closed); await bounded(work); await bounded(f.session.waitForIdle());
  assert.equal(Object.values(f.journal.load().replies!)[0].phase, "prepared", "no late write through the old attachment");
  const release = challenger.acquire(); release(); assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 1);
  assert.equal(f.server.current.status.state, "TASK_STATE_COMPLETED"); assert.equal(f.aborted, 0);
});
