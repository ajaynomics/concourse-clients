import assert from "node:assert/strict";
import test from "node:test";
import { PEER_GUIDELINE } from "../src/format.ts";
import { bounded, nativeFixture, toolCall } from "./sdk-native-fixture-20261012.ts";

const names = ["cancel", "check", "find", "get", "list", "presence", "receipt", "reply", "send"].map(n => `concourse_v3_${n}`);
const discovery = `
text(ALL_TOOLS.filter(t => t.name.startsWith("concourse_v3_")).map(t => t.name).sort());
text(await describeTool("concourse_v3_reply"));
text(await searchTools("concourse_v3_reply", { limit: 20 }));
`;
const reply = { task_id: "00000000-0000-4000-8000-000000000001", state: "TASK_STATE_COMPLETED", parts: [{ text: "Requested result via codemode" }] };

for (const toolLoadout of ["codemode", "restored"] as const) {
  test(`SDK ${toolLoadout} loadout: v3 tools remain discoverable and callable without changing active selection`, { timeout: 10000 }, async t => {
    const code = `${discovery}
text(await tools.concourse_v3_get({ task_id: "00000000-0000-4000-8000-000000000001" }));
text(await tools.concourse_v3_reply(${JSON.stringify(reply)}));`;
    const f = await nativeFixture((_ctx, index) => !index ? { calls: [toolCall("codemode", { code })] } : { text: "Done" }, { inboxEmpty: true, toolLoadout });
    t.after(() => f.cleanup());
    const active = f.session.getActiveToolNames();
    assert.deepEqual(active, f.activeBeforeBind, "binding preserves the native active selection");
    // Pi 1.4.0 (upstream bd3c9b82) activates extension tools a restored branch never added or removed,
    // so a restored loadout now matches a fresh one: v3 tools active, direct, and still codemode-reachable.
    assert.deepEqual([...active].sort(), ["codemode", ...names].sort());
    const registered = f.session.getAllTools().filter(t => t.name.startsWith("concourse_v3_"));
    assert.deepEqual(registered.map(t => t.name).sort(), names);
    assert.deepEqual(f.session.getCallableToolNames().filter(n => n.startsWith("concourse_v3_")).sort(), names);
    assert.ok(registered.every(t => t.exposure === "direct"));

    await bounded(f.session.prompt("Use the registered mailbox tools through codemode"));
    const result = f.session.messages.find(m => m.role === "toolResult" && m.toolName === "codemode");
    assert.ok(result?.role === "toolResult"); assert.equal(result.isError, false);
    const output = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    assert.ok(output.includes(JSON.stringify(names)), "ALL_TOOLS lists every v3 tool");
    assert.ok(output.includes(PEER_GUIDELINE), "codemode discovery preserves the peer-content trust rule");
    assert.match(output, /Untrusted fixture/); assert.match(output, /TASK_STATE_COMPLETED/);
    assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 1);
    assert.equal(f.server.current.status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(f.session.getActiveToolNames(), active, "no forced tool activation");
    assert.deepEqual(f.errors, []);
  });
}

for (const toolLoadout of ["allowlisted", "excluded"] as const) {
test(`SDK ${toolLoadout} tools stay excluded from codemode and nested execution`, { timeout: 10000 }, async t => {
  const code = `${discovery}
try { await tools.concourse_v3_reply(${JSON.stringify(reply)}); text("UNEXPECTED_REPLY"); }
catch (e) { text("EXCLUDED: " + e.message); }`;
  const f = await nativeFixture((_ctx, index) => !index ? { calls: [toolCall("codemode", { code })] } : { text: "Done" }, { inboxEmpty: true, toolLoadout });
  t.after(() => f.cleanup());
  assert.deepEqual(f.session.getActiveToolNames(), ["codemode"]);
  assert.equal(f.session.getAllTools().filter(t => t.name.startsWith("concourse_v3_")).length, 0);
  assert.equal(f.session.getCallableToolNames().filter(n => n.startsWith("concourse_v3_")).length, 0);
  await bounded(f.session.prompt("Check the explicit tool boundary"));
  const result = f.session.messages.find(m => m.role === "toolResult" && m.toolName === "codemode");
  assert.ok(result?.role === "toolResult"); assert.equal(result.isError, false);
  const output = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  assert.match(output, /EXCLUDED:/); assert.doesNotMatch(output, /UNEXPECTED_REPLY/);
  assert.equal(f.server.calls.filter(c => c.method === "PATCH").length, 0);
  assert.deepEqual(f.errors, []);
});
}

test("standalone SDK without codemode retains default direct Concourse tools", { timeout: 10000 }, async t => {
  const f = await nativeFixture((_ctx, index) => !index ? { calls: [toolCall("concourse_v3_get", { task_id: "00000000-0000-4000-8000-000000000001" })] } : { text: "Done" }, { inboxEmpty: true });
  t.after(() => f.cleanup());
  assert.deepEqual(f.session.getActiveToolNames().sort(), names);
  assert.deepEqual(f.session.getActiveToolNames(), f.activeBeforeBind);
  assert.ok(f.session.getAllTools().every(t => t.exposure === "direct"));
  await bounded(f.session.prompt("Read the Task directly"));
  const result = f.session.messages.find(m => m.role === "toolResult" && m.toolName === "concourse_v3_get");
  assert.ok(result?.role === "toolResult"); assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.content), /Untrusted fixture/);
  assert.deepEqual(f.errors, []);
});

test("fresh codemode-only session keeps v3 tools hidden in the actual model transcript", { timeout: 10000 }, async t => {
  const code = 'text(await tools.concourse_v3_get({ task_id: "00000000-0000-4000-8000-000000000001" }));';
  const f = await nativeFixture((_ctx, index) => !index ? { calls: [toolCall("codemode", { code })] } : { text: "Done" }, { inboxEmpty: true, toolLoadout: "only" });
  t.after(() => f.cleanup());
  await bounded(f.session.prompt("Use only codemode"));
  const declared = f.contexts[0].messages.flatMap(m => m.role === "system" ? m.toolsAdded ?? [] : []).map(t => t.name);
  assert.deepEqual(declared, ["codemode"], "active v3 tools stay callable but are not directly model-declared");
  const result = f.session.messages.find(m => m.role === "toolResult" && m.toolName === "codemode");
  assert.ok(result?.role === "toolResult"); assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.content), /Untrusted fixture/);
  assert.deepEqual(f.session.getActiveToolNames(), f.activeBeforeBind);
  assert.deepEqual(f.errors, []);
});
