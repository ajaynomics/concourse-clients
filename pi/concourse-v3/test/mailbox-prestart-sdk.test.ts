import assert from "node:assert/strict";
import test from "node:test";
import { bounded, nativeFixture } from "./sdk-native-fixture-20261012.ts";
import { deferred, task } from "./sdk-seams-fixture-20261012.ts";

test("native followUp preserves a submitted human prompt still preparing before agent_start", { timeout: 10000 }, async t => {
  const preparing = deferred<void>(), releasePreparation = deferred<void>(), humanEntered = deferred<void>(), peerStream = deferred<void>();
  const text = "Submitted human prompt  exact\n spacing";
  const f = await nativeFixture(context => {
    const hasHuman = JSON.stringify(context.messages).includes("Submitted human prompt");
    if (hasHuman) { humanEntered.resolve(); return { text: "Synthetic human work" }; }
    return { text: "Synthetic peer work", gate: peerStream };
  }, { inboxEmpty: true });
  t.after(async () => { releasePreparation.resolve(); peerStream.resolve(); await f.cleanup(); });
  f.api.on("before_agent_start", async event => {
    if (event.messageType === "user" && event.prompt === text) { preparing.resolve(); await releasePreparation.promise; }
  });
  const human = f.session.prompt(text).then(() => ({ preserved: true, error: "" }), e => ({ preserved: false, error: String(e) }));
  await bounded(preparing.promise);
  f.server.inbox = [task()];
  await f.session.prompt("/concourse-v3 refresh");
  releasePreparation.resolve();
  const result = await bounded(Promise.race([
    human,
    humanEntered.promise.then(() => ({ preserved: true, error: "" })),
  ]));
  assert.equal(result.preserved, true, `submitted human input must not be rejected by incoming mail: ${result.error}`);
  peerStream.resolve(); await bounded(human); await bounded(f.session.waitForIdle());
  assert.match(JSON.stringify(f.contexts), /Submitted human prompt/);
  assert.match(JSON.stringify(f.contexts), /A2A message from/);
  assert.equal(f.aborted, 0);
  assert.deepEqual(f.errors, []);
});

// Pi1.2.0 still lets a run start while async input handlers prepare a submitted prompt.
test("native followUp preserves a submitted human prompt still in async input handlers", { timeout: 10000 }, async t => {
  const preparing = deferred<void>(), releasePreparation = deferred<void>();
  const text = "Submitted human prompt in input handler";
  const f = await nativeFixture(context => ({ text: JSON.stringify(context.messages).includes("A2A message from") ? "Synthetic peer work" : "Synthetic human work" }), { inboxEmpty: true });
  t.after(async () => { releasePreparation.resolve(); await f.cleanup(); });
  f.api.on("input", async event => {
    if (event.text === text) { preparing.resolve(); await releasePreparation.promise; }
  });
  const human = f.session.prompt(text).then(() => ({ preserved: true, error: "" }), e => ({ preserved: false, error: String(e) }));
  await bounded(preparing.promise);
  f.server.inbox = [task()];
  await f.session.prompt("/concourse-v3 refresh");
  releasePreparation.resolve();
  const result = await bounded(human);
  assert.equal(result.preserved, true, `submitted human input must not be rejected by incoming mail: ${result.error}`);
  await bounded(f.session.waitForIdle());
  const contexts = f.contexts.map(c => JSON.stringify(c));
  assert.match(contexts[0], /Submitted human prompt in input handler/);
  assert.doesNotMatch(contexts[0], /A2A message from/, "the human prompt runs first");
  assert.match(contexts[contexts.length - 1], /A2A message from/);
  assert.equal(f.aborted, 0);
  assert.deepEqual(f.errors, []);
});
