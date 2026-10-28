import assert from "node:assert/strict";
import test from "node:test";
import { nativeFixture, bounded, toolCall } from "./sdk-native-fixture-20261012.ts";
import { answer } from "./helpers.ts";

test("real SDK send receipts, status polls and heartbeat create no turns, but a useful requested answer queues once", { timeout: 10000 }, async t => {
  const f = await nativeFixture((_context, index) => !index ? { calls: [toolCall("concourse_v3_send", { to: "other/sender", parts: [{ text: "Need a result" }] })] } : { text: "Synthetic normal conversation" }, { inboxEmpty: true });
  t.after(() => f.cleanup()); await bounded(f.session.prompt("Send a request"));
  assert.equal(f.contexts.length, 2); const before = f.contexts.length;
  f.server.ping(); await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
  assert.equal(f.contexts.length, before, "accepted/polling/heartbeat do not generate another turn");
  f.server.current = answer("requested-answer");
  await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
  assert.equal(f.contexts.length, before + 1); assert.match(JSON.stringify(f.contexts.at(-1)), /Actual requested result/);
  await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
  assert.equal(f.contexts.length, before + 1, "duplicate useful-answer observation stays quiet");
  assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0, "no automatic ACK"); assert.deepEqual(f.errors, []);
});

test("real SDK informational sends suppress unsolicited terminal reply turns but still surface a genuine input question", { timeout: 10000 }, async () => {
  for (const state of ["TASK_STATE_COMPLETED", "TASK_STATE_INPUT_REQUIRED"]) {
    const f = await nativeFixture((_context, index) => !index ? { calls: [toolCall("concourse_v3_send", { to: "other/sender", parts: [{ text: "Useful FYI" }], expect_reply: false })] } : { text: "Synthetic normal conversation" }, { inboxEmpty: true });
    try {
      await bounded(f.session.prompt("Send informational mail")); const before = f.contexts.length;
      f.server.current = answer("peer-result", state);
      await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
      assert.equal(f.contexts.length, before + (state === "TASK_STATE_INPUT_REQUIRED" ? 1 : 0));
      assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0); assert.deepEqual(f.errors, []);
    } finally { await f.cleanup(); }
  }
});
