import assert from "node:assert/strict";
import test from "node:test";
import { nativeFixture, bounded } from "./sdk-native-fixture-20261012.ts";
import { deferred, task } from "./sdk-seams-fixture-20261012.ts";

test("mail queues through Pi even when a human turn and human follow-up are already present", { timeout: 10000 }, async t => {
  const hold = deferred<void>(), entered = deferred<void>();
  const f = await nativeFixture((_context, index) => { if (!index) { entered.resolve(); return { text: "Original human work", gate: hold }; } return { text: "Normal queue processed" }; }, { background: true, inboxEmpty: true });
  t.after(() => f.cleanup());
  const original = f.session.prompt("Human operation"); await bounded(entered.promise);
  await f.session.followUp("Already queued human message");
  f.server.inbox = [task()];
  await f.session.prompt("/concourse-v3 refresh", { streamingBehavior: "followUp" });
  const queued = JSON.stringify(f.session.getFollowUpMessages());
  assert.match(queued, /Already queued human message/);
  // Pi's public string getter omits custom follow-ups; the later real model context proves receipt.
  assert.equal(Object.values(f.journal.load().batches)[0]?.phase, "handed-off");
  assert.equal(f.server.calls.filter(c => c.body?.delivery).length, 0);
  assert.equal(f.contexts.length, 1, "peer mail does not preempt the running model");
  assert.equal(f.aborted, 0);
  hold.resolve(); await bounded(original); await bounded(f.session.waitForIdle());
  assert.match(JSON.stringify(f.contexts), /Already queued human message/);
  assert.match(JSON.stringify(f.contexts), /A2A message from/);
  assert.deepEqual(f.errors, []);
});
