import assert from "node:assert/strict";
import test from "node:test";
import { nativeFixture, bounded } from "./sdk-native-fixture-20261012.ts";
import { task, answer } from "./helpers.ts";

test("one over-limit Task cannot starve valid mail or requested output", { timeout: 10000 }, async t => {
  const f = await nativeFixture(() => ({ text: "Normal queue processes independent mail" }), { inboxEmpty: true });
  t.after(() => f.cleanup());
  const huge = { ...task(), id: "oversized-task" }; huge.history![0].parts = [{ text: "x".repeat(300000) }];
  f.server.inbox = [{ ...task("TASK_STATE_WORKING", ["fresh-mail"]), id: "valid-task" }, huge];
  const l = f.journal.load(); l.outgoing.original = { messageId: "original", recipient: "other/sender", taskId: "00000000-0000-4000-8000-000000000001", phase: "accepted", expectReply: true }; f.journal.save(l);
  f.server.current = answer("actual-result");
  await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
  assert.match(JSON.stringify(f.contexts), /A2A message from [^"]*task valid-task/);
  assert.ok(Object.values(f.journal.load().batches).some(b => b.messageIds.includes("fresh-mail") && b.phase === "handed-off"));
  assert.match(JSON.stringify(f.contexts), /Actual requested result/);
  assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0);
  assert.equal(f.journal.load().blockedInbox?.["oversized-task"]?.code, "DELIVERY_MESSAGE_LIMIT");
});

test("joined refresh waits for its newer read even after earlier I/O fails, without inspecting native queues", { timeout: 10000 }, async () => {
  for (const failure of [undefined, 503]) {
    const f = await nativeFixture(() => ({ text: "Peer queued normally" }), { inboxEmpty: true });
    try {
      f.server.reached.delete("inbox"); const gate = f.server.hold("inbox"); f.server.inboxFailureOnce = failure;
      const old = f.session.prompt("/concourse-v3 refresh"); await bounded(f.server.signal("inbox").promise);
      f.server.inbox = [task("TASK_STATE_WORKING", ["new-mail-after-snapshot"])];
      const joined = f.session.prompt("/concourse-v3 refresh"); gate.resolve();
      await bounded(Promise.all([old, joined])); await bounded(f.session.waitForIdle());
      assert.match(JSON.stringify(f.contexts), /A2A message from/);
      assert.ok(Object.values(f.journal.load().batches).some(b => b.messageIds.includes("new-mail-after-snapshot") && b.phase === "handed-off"));
      assert.equal(f.aborted, 0); assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0);
    } finally { await f.cleanup(); }
  }
});
