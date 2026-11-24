import assert from "node:assert/strict";
import test from "node:test";
import { incoming } from "../src/format.ts";
import { bounded, nativeFixture } from "./sdk-native-fixture-20261012.ts";
import { deferred, task } from "./sdk-seams-fixture-20261012.ts";

test("A2A new-turn mail queues while busy behind human steering, preserving exact text without abort or replay", { timeout: 10000 }, async t => {
  const entered = deferred<void>(), release = deferred<void>();
  const human = "Initial human work  exact\n spacing", steering = "Human steering  exact\n spacing";
  const f = await nativeFixture((_context, index) => {
    if (!index) { entered.resolve(); return { text: "Initial work", gate: release }; }
    return { text: "Native queue processed" };
  }, { inboxEmpty: true });
  t.after(async () => { release.resolve(); await f.cleanup(); });
  const original = f.session.prompt(human);
  await bounded(entered.promise);
  assert.equal(await f.session.steer(steering), "queued");
  const mail = task();
  mail.history![0].parts = [{ text: "Peer mail  exact\n spacing" }];
  f.server.inbox = [mail];
  await f.session.prompt("/concourse-v3 refresh");
  const batches = Object.values(f.journal.load().batches);
  assert.equal(batches.length, 1);
  const b = batches[0];
  assert.equal(b.phase, "handed-off", "busy input must not impose an idle/draft admission gate");
  assert.deepEqual(b.messageIds, mail.history!.map(m => m.messageId), "peer message IDs remain as dedupe fences");
  assert.equal(b.messages, undefined, "handed-off content is not retained in the ledger");
  const expectedMail = incoming({ taskId: b.taskId, contextId: b.contextId, caller: b.caller, messages: mail.history!, artifacts: mail.artifacts ?? [] });
  assert.equal(f.contexts.length, 1, "neither steering nor mail preempts the held initial model call");
  assert.equal(f.aborted, 0);
  release.resolve(); await bounded(original); await bounded(f.session.waitForIdle());
  const consumed = f.events.filter(e => e.type === "message_start" && ["user", "custom"].includes(e.message.role)).map(e =>
    typeof e.message.content === "string" ? e.message.content : e.message.content.map((p: { text?: string }) => p.text ?? "").join(""));
  assert.deepEqual(consumed, [human, steering, expectedMail], "exact messages are consumed once in native priority order");
  assert.equal(f.contexts.length, 3, "mail gets a distinct model request after steering, not steering delivery");
  assert.doesNotMatch(JSON.stringify(f.contexts[1]), /A2A message from/);
  assert.match(JSON.stringify(f.contexts[2]), /Peer mail  exact/);
  await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
  assert.equal(f.contexts.length, 3, "a repeated inbox observation never replays queued mail");
  assert.equal(f.observed.length, 1);
  assert.equal(f.aborted, 0);
  assert.equal(f.guard.forbidden, 0);
  assert.deepEqual(f.errors, []);
});
