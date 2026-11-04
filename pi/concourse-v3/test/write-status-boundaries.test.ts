import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Client } from "../src/client.ts";
import { PrivateFiles, emptyLedger } from "../src/storage.ts";
import { SafeError } from "../src/http.ts";
import { attention, statusLine } from "../src/status.ts";
import type { Ledger } from "../src/types.ts";
import { nativeFixture, bounded } from "./sdk-native-fixture-20261012.ts";
import { deferred } from "./helpers.ts";

// Real SDK registration/context, Client/A2A SDK, Replies/Outbox and descriptor-rooted
// private files. Only the synthetic server and the precise accepted-save fault vary.
type Fixture = Awaited<ReturnType<typeof nativeFixture>>;
function execute(f: Fixture, name: string, params: Record<string, unknown>) {
  const runner = f.session.extensionRunner, id = `boundary-${name}`;
  const tool = runner.getToolDefinition(`concourse_v3_${name}`);
  assert.ok(tool, "exercise the registered index.ts wrapper, not just its domain object");
  return tool.execute(id, params, undefined, undefined, runner.createToolContext(id, undefined));
}
function replaceLock(f: Fixture) {
  const replacement = join(f.root, "replacement.json");
  writeFileSync(replacement, "{}", { mode: 0o600 });
  renameSync(replacement, join(f.root, "consumer.json"));
}
const stale = (e: unknown) => e instanceof SafeError && e.code === "SESSION_REPLACED";
async function assertStaleOperations(f: Fixture) {
  const beforeCalls = f.server.calls.length, before = readFileSync(join(f.root, "ledger.json"));
  for (const [name, params] of [
    ["send", { to: "other/sender", parts: [{ text: "must not publish" }] }],
    ["reply", { task_id: "00000000-0000-4000-8000-000000000001", state: "TASK_STATE_COMPLETED" }],
    ["cancel", { to: "other/sender", task_id: "00000000-0000-4000-8000-000000000001" }],
    ["get", { task_id: "00000000-0000-4000-8000-000000000001" }], ["find", {}], ["check", {}],
  ] as const) await assert.rejects(execute(f, name, params), stale);
  assert.equal(f.server.calls.length, beforeCalls, "no new HTTP after ownership loss");
  assert.deepEqual(readFileSync(join(f.root, "ledger.json")), before, "no stale ledger mutation");
}

for (const operation of ["send", "reply"] as const) {
  test(`registered ${operation}: known acceptance/artifact and do-not-repeat warning survive lock loss at local save`, async t => {
    const f = await nativeFixture(undefined, { inboxEmpty: true });
    const originalWrite = PrivateFiles.prototype.write;
    let faulted = false;
    t.mock.method(PrivateFiles.prototype, "write", function (this: PrivateFiles, name: string, value: unknown) {
      const ledger = value as Ledger;
      if (this.root === f.root && name === "ledger.json" && (operation === "send" ? Object.values(ledger.outgoing) : Object.values(ledger.replies ?? {})).some(o => o.phase === "accepted")) {
        assert.equal(faulted, false); faulted = true; replaceLock(f);
      }
      return originalWrite.call(this, name, value);
    });
    try {
      const accepted = { id: "00000000-0000-4000-8000-000000000001", contextId: "context1", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: "accepted-artifact", parts: [{ text: "known accepted body" }] }] };
      f.server.rpcResult = { task: accepted };
      const result = await execute(f, operation, operation === "send"
        ? { to: "other/sender", parts: [{ text: "authored request" }] }
        : { task_id: "00000000-0000-4000-8000-000000000001", state: "TASK_STATE_COMPLETED", artifacts: [{ parts: [{ text: "known accepted body" }] }] });
      assert.equal(faulted, true);
      const { result: receipt } = result.structuredContent as unknown as { result: { result?: unknown; task?: { id: string; artifacts: unknown[] }; messageId?: string; warning: string } };
      assert.match(receipt.warning, /Server accepted; local .*save failed/);
      assert.match(receipt.warning, operation === "send" ? /do not resend/i : /Do not repeat the reply/);
      if (operation === "send") {
        assert.deepEqual(receipt.result, accepted); assert.ok(receipt.messageId);
        const intent = f.journal.load().outgoing[receipt.messageId!];
        assert.equal(intent.phase, "prepared"); assert.deepEqual(intent.parts, [{ text: "authored request" }]);
      } else {
        assert.equal(receipt.task!.id, "00000000-0000-4000-8000-000000000001"); assert.deepEqual(receipt.task!.artifacts, [{ artifactId: "server-art-0", parts: [{ text: "known accepted body" }] }]);
        const intent = Object.values(f.journal.load().replies!)[0];
        assert.equal(intent.phase, "prepared"); assert.equal(intent.taskId, "00000000-0000-4000-8000-000000000001");
        assert.deepEqual(intent.outcome.artifacts, [{ parts: [{ text: "known accepted body" }] }]);
      }
      assert.match(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"), /known accepted body/);
      assert.equal(f.server.calls.filter(c => c.method === "POST" || c.method === "PATCH").length, 1, "one accepted publication only");
      await assertStaleOperations(f);
      assert.deepEqual(f.errors, []);
    } finally { t.mock.restoreAll(); await f.cleanup(); }
  });
}

test("registered reads retain the post-result fence; no new writes or reads follow a stale read", async t => {
  const f = await nativeFixture(undefined, { inboxEmpty: true }), original = Client.prototype.find;
  t.mock.method(Client.prototype, "find", async function (this: Client, query?: string) {
    const value = await original.call(this, query); replaceLock(f); return value;
  });
  try {
    await assert.rejects(execute(f, "find", {}), stale);
    await assertStaleOperations(f);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test("registered send/reply unknown HTTP responses still throw, never fabricate accepted receipts", async t => {
  const f = await nativeFixture(undefined, { inboxEmpty: true });
  try {
    f.server.rpcFailure = "lost";
    await assert.rejects(execute(f, "send", { to: "other/sender", parts: [{ text: "unknown send" }] }), (e: unknown) => e instanceof SafeError && e.uncertain && /SEND_UNCONFIRMED/.test(e.code));
    const originalRequest = Client.prototype.request;
    // The real PATCH is issued once; drop its result before Client.reply can confirm it.
    t.mock.method(Client.prototype, "request", async function (this: Client, ...args: Parameters<typeof originalRequest>) {
      const value = await originalRequest.apply(this, args);
      if (args[0] === "PATCH") throw new SafeError("HTTP_TRANSPORT_FAILED", true);
      return value;
    });
    await assert.rejects(execute(f, "reply", { task_id: "00000000-0000-4000-8000-000000000001", state: "TASK_STATE_COMPLETED" }), (e: unknown) => e instanceof SafeError && e.uncertain && /REPLY_UNCONFIRMED/.test(e.code));
    assert.deepEqual(Object.values(f.journal.load().outgoing).map(o => o.phase), ["uncertain"]);
    assert.deepEqual(Object.values(f.journal.load().replies!).map(o => o.phase), ["uncertain"]);
    assert.equal(f.server.calls.filter(c => c.method === "POST" || c.method === "PATCH").length, 2);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

function preparedLedger(): Ledger {
  const l = emptyLedger();
  for (const phase of ["prepared", "uncertain", "accepted", "refused"] as const) {
    l.outgoing[`send-${phase}`] = { messageId: `send-${phase}`, recipient: "other/sender", taskId: "original-task", contextId: "original-context", parts: [{ text: `retained send ${phase}` }], expectReply: true, phase };
    l.replies ??= {};
    l.replies[`reply-${phase}`] = { id: `reply-${phase}`, taskId: `original-task-${phase}`, outcome: { state: "TASK_STATE_COMPLETED", artifacts: [{ artifactId: `original-artifact-${phase}`, parts: [{ text: `retained reply ${phase}` }] }] }, phase };
  }
  return l;
}

test("prepared and uncertain intents count as unconfirmed, including footer starting before any fresh check", () => {
  const counts = attention(preparedLedger(), "session");
  assert.deepEqual(counts, { mail: 0, unconfirmed: 4, blocked: 0 });
  assert.match(statusLine({ handle: "owner/recipient", host: "concourse.invalid", live: false, failures: 0 }, counts), /starting · 4 unconfirmed: \/concourse-v3 status/);
});

test("SDK restart/registered status exposes crash-left intents without replay, network writes or content/ID loss", async t => {
  const f = await nativeFixture(undefined, { inboxEmpty: true });
  const runner = f.session.extensionRunner, notifications: string[] = [], footers: string[] = [];
  const gate = deferred<void>(), entered = deferred<void>(), originalIdentity = Client.prototype.identity;
  try {
    await runner.emit({ type: "session_shutdown", reason: "reload" });
    const ledger = preparedLedger(); f.journal.save(ledger);
    const beforeCalls = f.server.calls.length;
    runner.setUIContext({ ...runner.getUIContext(), notify: message => notifications.push(message), setStatus: (_key, message) => { if (message) footers.push(message); } }, "print");
    t.mock.method(Client.prototype, "identity", async function (this: Client) { entered.resolve(); await gate.promise; return originalIdentity.call(this); });
    await runner.emit({ type: "session_start", reason: "reload" }); await entered.promise;
    assert.ok(footers.some(line => /starting · 4 unconfirmed/.test(line)), "startup attention does not depend on a fresh network check");
    const command = runner.getCommand("concourse-v3")!;
    await command.handler("status", runner.createCommandContext());
    assert.match(notifications.at(-1)!, /Unconfirmed send send-prepared.*publication may have occurred; \/concourse-v3 reconcile send-prepared; do not resend/);
    assert.match(notifications.at(-1)!, /Unconfirmed reply reply-prepared on Task original-task-prepared.*publication may have occurred; read the original Task before retrying; do not repeat/);
    assert.equal(notifications.at(-1)!.includes("send-accepted"), false); assert.equal(notifications.at(-1)!.includes("reply-refused"), false);
    // Existing Mailbox.recover may mark prepared -> uncertain; it must retain the exact
    // payload/IDs and never replay them. Status itself must not normalize anything.
    const recovered = f.journal.load();
    for (const key of ["outgoing", "replies"] as const) for (const [id, intent] of Object.entries(ledger[key]!)) assert.deepEqual(recovered[key]![id], { ...intent, phase: intent.phase === "prepared" ? "uncertain" : intent.phase });
    // Also inspect still-prepared records left during this live runtime's failed save.
    f.journal.save(ledger);
    const beforeStatus = readFileSync(join(f.root, "ledger.json"));
    await command.handler("status", runner.createCommandContext());
    assert.deepEqual(readFileSync(join(f.root, "ledger.json")), beforeStatus);
    assert.match(notifications.at(-1)!, /send-prepared.*do not resend/); assert.match(notifications.at(-1)!, /reply-prepared.*do not repeat/);
    assert.equal(f.server.calls.length, beforeCalls, "status and recovery add no HTTP or publication");
  } finally {
    // Invalidate before releasing the synthetic read; shutdown drains its own I/O.
    const shutdown = runner.emit({ type: "session_shutdown", reason: "quit" }); gate.resolve();
    await bounded(shutdown); t.mock.restoreAll(); await f.cleanup();
  }
});
