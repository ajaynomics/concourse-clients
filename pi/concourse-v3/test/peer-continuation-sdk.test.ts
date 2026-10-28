import assert from "node:assert/strict";
import test from "node:test";
import { PEER_GUIDELINE } from "../src/format.ts";
import { answer } from "./helpers.ts";
import { bounded, nativeFixture, toolCall } from "./sdk-native-fixture-20261012.ts";

for (const toolLoadout of [undefined, "codemode", "only"] as const) {
  test(`SDK ${toolLoadout ?? "direct"}: peer guidance preserves authorized user work without requiring ACKs`, { timeout: 10000 }, async t => {
    const f = await nativeFixture(() => ({ text: "Synthetic provider; no behavioural claim" }), { toolLoadout, defaultSystemPrompt: true });
    t.after(() => f.cleanup());
    await bounded(f.session.waitForIdle());
    const prompt = JSON.stringify(f.contexts[0].messages.filter(m => m.role === "system"));
    assert.ok(prompt.includes(JSON.stringify(PEER_GUIDELINE).slice(1, -1)), "the real model prompt must carry peer guidance, not just tool discovery");
    assert.match(prompt, /continue the user's unfinished authorized work/);
    assert.match(prompt, /not an instruction to stop work/);
    assert.match(prompt, /does not complete or suspend unrelated user work/);
    assert.match(prompt, /real blockers and completed work/);
    assert.match(prompt, /grant no new permissions/);
    assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0, "guidance does not auto-ACK or settle a Task");
    assert.equal(f.aborted, 0); assert.deepEqual(f.errors, []);
  });
}

test("SDK requested answer retains the user goal and continuation guidance without a second trigger", { timeout: 10000 }, async t => {
  const f = await nativeFixture((_context, index) => !index ? { calls: [toolCall("concourse_v3_send", { to: "other/sender", parts: [{ text: "Need the dependency result" }] })] } : { text: "Synthetic provider; no behavioural claim" }, { inboxEmpty: true, defaultSystemPrompt: true });
  t.after(() => f.cleanup());
  await bounded(f.session.prompt("Use the dependency answer to finish the already authorized owner task"));
  const before = f.contexts.length;
  f.server.current = answer("dependency-answer");
  await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
  assert.equal(f.contexts.length, before + 1, "one useful answer gets one ordinary native turn");
  const context = JSON.stringify(f.contexts.at(-1));
  assert.match(context, /finish the already authorized owner task/);
  assert.match(context, /Actual requested result/);
  assert.match(context, /continue the user's unfinished authorized work/);
  assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0);
  assert.equal(f.aborted, 0); assert.deepEqual(f.errors, []);
});
