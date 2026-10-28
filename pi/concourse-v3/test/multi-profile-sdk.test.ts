import assert from "node:assert/strict";
import test from "node:test";
import { nativeFixture, bounded, toolCall } from "./sdk-native-fixture-20261012.ts";
import { PrivateFiles } from "../src/storage.ts";

test("real Pi SDK holds two profiles: each mail is labelled and the reply returns only to its server", { timeout: 10000 }, async t => {
  let replied = false;
  const f = await nativeFixture(context => {
    // Reply once the second server's mail is in the conversation; routing comes from that profile's ledger.
    if (!replied && JSON.stringify(context).includes("task2")) { replied = true; return { calls: [toolCall("concourse_v3_reply", { task_id: "task2", state: "TASK_STATE_COMPLETED", parts: [{ text: "Answer for the second server" }] })] }; }
    return { text: "No reply" };
  }, { second: true });
  t.after(() => f.cleanup());
  await bounded((async () => { while (!replied || f.second!.server.calls.every(c => c.method !== "PATCH")) await new Promise(r => setTimeout(r, 10)); })());
  await bounded(f.session.waitForIdle());
  const mail = (f.observed as { customType: string; content: string; details: { profile?: string } }[]).filter(m => m.customType === "concourse-v3.delivery");
  assert.deepEqual(mail.map(m => m.details.profile).sort(), ["concourse.invalid/owner/recipient", "second.invalid/owner/second"]);
  assert.ok(mail.some(m => m.content.startsWith("[concourse.invalid · owner/recipient] A2A message from")));
  assert.ok(mail.some(m => m.content.startsWith("[second.invalid · owner/second] A2A message from")));
  assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0, "nothing written to the first server");
  assert.equal(f.second!.server.current.status.state, "TASK_STATE_COMPLETED");
  assert.equal(Object.values(f.second!.journal.load().replies!)[0].phase, "accepted");
  assert.equal(f.journal.load().replies, undefined);
  assert.equal(f.aborted, 0); assert.deepEqual(f.errors, []);

  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  for (const root of [f.root, f.second!.root]) { const files = new PrivateFiles(root); files.acquire()(); files.close(); }
});
