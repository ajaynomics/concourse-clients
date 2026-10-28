import assert from "node:assert/strict";
import test from "node:test";
import { ANSWER_TYPE } from "../src/runtime.ts";
import type { ToolCall } from "@earendil-works/pi-ai";
import { nativeFixture, bounded, toolCall } from "./sdk-native-fixture-20261012.ts";
import { answer } from "./helpers.ts";

// A2A Task snapshots retain old status messages/artifacts; concourse.output marks this status's new output.
test("artifact-only completion queues only fresh output, while explicit get retains full Task history", { timeout: 10000 }, async t => {
  let next: ToolCall | undefined = toolCall("concourse_v3_send", { to: "other/sender", parts: [{ text: "Need a result" }] });
  const f = await nativeFixture(() => { const call = next; next = undefined; return call ? { calls: [call] } : { text: "Ordinary conversation" }; }, { inboxEmpty: true });
  t.after(() => f.cleanup());
  await bounded(f.session.prompt("Send the request"));
  const question = answer("question-1", "TASK_STATE_INPUT_REQUIRED");
  question.status.message!.parts = [{ text: "ALREADY_ANSWERED_QUESTION" }];
  question.artifacts = [{ artifactId: "old-artifact", parts: [{ text: "OBSOLETE_ARTIFACT" }] }];
  question.metadata!["concourse.output"] = { statusTimestamp: question.status.timestamp!, messageIds: ["question-1"], artifactIds: ["old-artifact"] };
  f.server.current = structuredClone(question);
  await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
  const questionMail = f.observed.at(-1) as { customType: string; content: string };
  assert.equal(questionMail.customType, ANSWER_TYPE); assert.match(questionMail.content, /ALREADY_ANSWERED_QUESTION/);

  const stamp = "2026-10-16T20:00:00.000Z";
  f.server.current = { ...question, status: { ...question.status, state: "TASK_STATE_WORKING", timestamp: stamp }, metadata: { "concourse.output": { statusTimestamp: stamp, messageIds: [], artifactIds: [] } } };
  f.server.rpcResult = { task: f.server.current };
  next = toolCall("concourse_v3_send", { to: "other/sender", task_id: "task1", parts: [{ text: "Answer to question-1" }] });
  await bounded(f.session.prompt("Provide the requested input"));
  const before = f.observed.length;
  f.server.current = { ...f.server.current, status: { ...f.server.current.status, state: "TASK_STATE_COMPLETED" }, artifacts: [...question.artifacts, { artifactId: "new-artifact", parts: [{ text: "FRESH_ARTIFACT_RESULT" }] }], metadata: { "concourse.output": { statusTimestamp: stamp, messageIds: [], artifactIds: ["new-artifact"] } } };
  await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
  assert.equal(f.observed.length, before + 1);
  const freshMail = f.observed.at(-1) as { customType: string; content: string };
  assert.equal(freshMail.customType, ANSWER_TYPE);
  assert.match(freshMail.content, /FRESH_ARTIFACT_RESULT/);
  assert.doesNotMatch(freshMail.content, /ALREADY_ANSWERED_QUESTION|OBSOLETE_ARTIFACT/);
  await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
  assert.equal(f.observed.length, before + 1, "no repeated handoff");

  next = toolCall("concourse_v3_get", { task_id: "task1" });
  await bounded(f.session.prompt("Read the full Task explicitly"));
  const read = f.session.messages.find(m => m.role === "toolResult" && m.toolName === "concourse_v3_get");
  assert.ok(read?.role === "toolResult"); assert.equal(read.isError, false);
  const raw = JSON.stringify(read.content);
  for (const text of ["ALREADY_ANSWERED_QUESTION", "OBSOLETE_ARTIFACT", "FRESH_ARTIFACT_RESULT"]) assert.ok(raw.includes(text));
  assert.deepEqual(f.errors, []);
});
