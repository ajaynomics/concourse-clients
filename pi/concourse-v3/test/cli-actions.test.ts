import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, renameSync, symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { executeCommand, parseCommand, validatePayload } from "../src/commands.ts";
import { main, parseArgs } from "../cli.ts";
import { profile, config } from "./helpers.ts";
import { WireFixture, syntheticToken, outboundGuard, response, task } from "./sdk-seams-fixture-20261012.ts";
import type { Ledger } from "../src/types.ts";
function fixture() {
  const p = profile(), server = new WireFixture();
  p.files.write("config.json", config);
  p.files.write("tokens.json", { access: syntheticToken, expires: Date.now() + 3600_000, resource: config.origin, issuer: config.issuer, clientId: config.oauthClientId });
  const argv = (command: string, ...rest: string[]) => [command, "--profile", p.root, ...rest];
  const input = (value: unknown) => { const path = join(p.base, "input.json"); writeFileSync(path, JSON.stringify(value)); return path; };
  return { ...p, server, argv, input };
}
test("strict action arguments and payloads reject before network or journal", async t => {
  const f = fixture(); t.after(f.cleanup);
  for (const args of [["identity"], ["task", "--profile", "relative", "--task-id", "t"], f.argv("identity", "positional"), f.argv("find", "--query", "x", "--query", "y"), f.argv("send", "--recipient", "https://bad", "--input", "/file"), f.argv("task"), f.argv("presence", "--agent", "owner/agent", "--unknown", "x")]) assert.throws(() => parseCommand(args));
  assert.equal(parseArgs(f.argv("identity")).command, "identity");
  for (const [command, body] of [
    ["send", {}], ["send", { parts: [] }], ["send", { parts: [{ text: "x", data: {} }] }], ["send", { parts: [{ text: "x", extra: 1 }] }], ["send", { parts: [{ text: "x" }], expectReply: "yes" }], ["send", { parts: [{ text: "x" }], taskId: "" }],
    ["reply", { state: "TASK_STATE_CANCELED" }], ["reply", { state: "TASK_STATE_INPUT_REQUIRED" }], ["reply", { state: "TASK_STATE_COMPLETED", expected_caller_input: {} }], ["reply", { state: "TASK_STATE_COMPLETED", artifacts: [{ artifactId: "not-a-write-field", parts: [{ text: "x" }] }] }],
  ] as const) {
    assert.throws(() => validatePayload(command, body));
    const args = f.argv(command, ...(command === "send" ? ["--recipient", "other/sender"] : ["--task-id", "00000000-0000-4000-8000-000000000001"]), "--input", f.input(body));
    await assert.rejects(executeCommand(args, f.server.fetch));
  }
  assert.equal(f.server.calls.length, 0); assert.equal(f.files.read("ledger.json"), undefined);
});
test("bounded identity/find/task/inbox/presence mapping, no background polling; lock spans awaited reads", async t => {
  const f = fixture(), guard = outboundGuard(); t.after(() => { guard.close(); f.cleanup(); });
  for (const [name, flags] of [["identity", []], ["find", ["--query", "name & space"]], ["task", ["--task-id", "00000000-0000-4000-8000-000000000001"]], ["presence", ["--agent", "other/sender"]]] as const) await executeCommand(f.argv(name, ...flags), f.server.fetch);
  const gate = f.server.hold("inbox");
  const pending = executeCommand(f.argv("inbox"), f.server.fetch);
  await f.server.signal("inbox").promise;
  await assert.rejects(executeCommand(f.argv("identity"), f.server.fetch), /PROFILE_BUSY/);
  assert.throws(() => f.files.acquire(), /already owned/);
  gate.resolve(); const first = await pending as { nextPageToken: string };
  await executeCommand(f.argv("inbox", "--page-token", first.nextPageToken), f.server.fetch);
  assert.deepEqual(f.server.pageTokens, ["", "sdk-page-2"]);
  assert.ok(f.server.calls.some(c => c.url.includes("query=name+%26+space")));
  assert.equal(f.server.unsupported, 0); assert.equal(f.files.read("ledger.json"), undefined);
  const release = f.files.acquire(); release();
});
test("real SDK Task/direct Message send journals before wire and retains union and IDs", async t => {
  const f = fixture(), guard = outboundGuard(); t.after(() => { guard.close(); f.cleanup(); });
  for (const result of [{ task: task() }, { message: { messageId: "direct1", role: "ROLE_AGENT", parts: [{ text: "Answer" }] } }]) {
    f.server.rpcResult = result;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (init?.method === "POST") assert.ok(Object.values(f.files.read<Ledger>("ledger.json")!.outgoing).some(o => o.phase === "prepared"));
      return f.server.fetch(url, init);
    };
    const sent = await executeCommand(f.argv("send", "--recipient", "other/sender", "--input", f.input({ parts: [{ text: "Question" }], expectReply: false, taskId: "00000000-0000-4000-8000-000000000001", contextId: "context1" })), fetchImpl) as { result: unknown; messageId: string };
    assert.deepEqual(sent.result, "task" in result ? result.task : result.message);
    const stored = f.files.read<Ledger>("ledger.json")!.outgoing[sent.messageId]; assert.equal(stored.phase, "accepted");
    const post = f.server.calls.at(-1)!; assert.equal(post.body.params.message.messageId, sent.messageId); assert.equal(post.body.params.configuration.returnImmediately, true);
  }
  assert.equal(f.server.calls.length, 6); assert.equal(f.server.unsupported, 0);
});
test("reply journals exact explicit outcome before PATCH; send/reply uncertainty never replays or leaks", async t => {
  const f = fixture(); t.after(f.cleanup);
  const reply = f.argv("reply", "--task-id", "00000000-0000-4000-8000-000000000001", "--input", f.input({ state: "TASK_STATE_COMPLETED", parts: [{ data: { answer: true } }] }));
  await executeCommand(reply, async (url, init) => {
    if (init?.method === "PATCH") {
      const intents = Object.values(f.files.read<Ledger>("ledger.json")!.replies!); assert.equal(intents[0].phase, "prepared");
      assert.deepEqual(JSON.parse(String(init.body)), { state: "TASK_STATE_COMPLETED", message: { parts: [{ data: { answer: true } }] } });
    }
    return f.server.fetch(url, init);
  });
  let patches = 0; const lines: string[] = [];
  assert.equal(await main([...reply, "--json"], undefined, line => lines.push(line), { fetchImpl: async (url, init) => { if (init?.method === "PATCH") { patches++; throw new Error("secret private token"); } return f.server.fetch(url, init); } }), 1);
  assert.equal(patches, 1); assert.equal(JSON.parse(lines[0]).uncertain, true); assert.match(lines[0], /replyId=/); assert.ok(!lines[0].includes("secret private"));
  f.server.rpcFailure = "lost";
  await assert.rejects(executeCommand(f.argv("send", "--recipient", "other/sender", "--input", f.input({ parts: [{ text: "x" }] })), f.server.fetch), /messageId=/);
  assert.equal(Object.values(f.files.read<Ledger>("ledger.json")!.outgoing)[0].phase, "uncertain");
  const release = f.files.acquire(); release();
});
test("cancel uses one SDK CancelTask and preserves uncertain original Task without retry", async t => {
  const f = fixture(); t.after(f.cleanup); let posts = 0;
  const calls: string[] = [];
  const args = f.argv("cancel", "--recipient", "other/sender", "--task-id", "00000000-0000-4000-8000-000000000001", "--json");
  const fetchImpl: typeof fetch = async (url, init) => {
    if (init?.method === "POST") { posts++; const body = JSON.parse(String(init.body)); assert.equal(body.method, "CancelTask"); assert.equal(body.params.id, "00000000-0000-4000-8000-000000000001"); throw new Error("lost"); }
    return f.server.fetch(url, init);
  };
  assert.equal(await main(args, undefined, s => calls.push(s), { fetchImpl }), 1);
  assert.equal(posts, 1); assert.equal(JSON.parse(calls[0]).uncertain, true);
  assert.equal(JSON.parse(calls[0]).taskId, "00000000-0000-4000-8000-000000000001"); assert.equal(JSON.parse(calls[0]).recipient, "other/sender");
});
test("cancel preserves the original Task state and keeps malformed results uncertain", async t => {
  const f = fixture(); t.after(f.cleanup);
  const working = task(), canceled = { ...working, status: { state: "TASK_STATE_CANCELED" } };
  for (const result of [{}, { ...canceled, id: "unrelated-task" }, { id: "00000000-0000-4000-8000-000000000001" }, working, canceled]) {
    let posts = 0; const lines: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      if (init?.method === "POST") {
        posts++; const request = JSON.parse(String(init.body));
        assert.equal(request.method, "CancelTask");
        return response({ jsonrpc: "2.0", id: request.id, result });
      }
      return f.server.fetch(url, init);
    };
    const code = await main(f.argv("cancel", "--recipient", "other/sender", "--task-id", "00000000-0000-4000-8000-000000000001", "--json"), undefined, s => lines.push(s), { fetchImpl });
    const output = JSON.parse(lines[0]);
    assert.equal(posts, 1);
    if (result === canceled || result === working) { assert.equal(code, 0); assert.deepEqual(output.result, result); }
    else { assert.equal(code, 1); assert.equal(output.uncertain, true); assert.equal(output.taskId, "00000000-0000-4000-8000-000000000001"); assert.equal(output.recipient, "other/sender"); }
  }
});
test("receipt and reconcile query only original IDs and leave absent receipt uncertain", async t => {
  const f = fixture(); t.after(f.cleanup);
  f.server.rpcFailure = "lost";
  await assert.rejects(executeCommand(f.argv("send", "--recipient", "other/sender", "--input", f.input({ parts: [{ text: "x" }] })), f.server.fetch));
  f.server.rpcFailure = undefined;
  const id = Object.keys(f.files.read<Ledger>("ledger.json")!.outgoing)[0];
  await executeCommand(f.argv("receipt", "--recipient", "other/sender", "--message-id", id), f.server.fetch);
  await assert.rejects(executeCommand(f.argv("reconcile-send", "--message-id", id), f.server.fetch), /UNRESOLVED/);
  const data = f.server.calls.at(-1)!.body.params.message.parts[0].data;
  assert.deepEqual(data, { operation: "delivery", recipient: "other/sender", messageId: id });
  assert.equal(f.files.read<Ledger>("ledger.json")!.outgoing[id].phase, "uncertain");
});
test("token refresh holds same lock and failures release without printing credentials", async t => {
  const f = fixture(); t.after(f.cleanup); f.files.write("tokens.json", { access: syntheticToken, expires: 0, resource: config.origin, issuer: config.issuer, clientId: config.oauthClientId });
  const lines: string[] = [];
  const code = await main(f.argv("identity", "--json"), undefined, s => lines.push(s), { fetchImpl: async (url) => {
    assert.equal(String(url), config.tokenEndpoint); assert.throws(() => f.files.acquire(), /already owned/);
    return response({ secret: config.auth }, 500);
  } });
  assert.equal(code, 1); assert.ok(!lines.join().includes("synthetic-not-a-credential"));
  const release = f.files.acquire(); release();
});

test("list returns exactly one bounded page and validates filters before I/O", async t => {
  const f = fixture(); t.after(f.cleanup); const tokens: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/tasks") {
      assert.equal(u.searchParams.get("pageSize"), "50"); assert.equal(u.searchParams.get("status"), "TASK_STATE_WORKING");
      tokens.push(u.searchParams.get("pageToken") ?? "");
      return response({ tasks: [task()], nextPageToken: "next&opaque", totalSize: 100 });
    }
    return f.server.fetch(url, init);
  };
  for (const args of [f.argv("list", "--status", "working"), f.argv("list", "--page-token", "x".repeat(2049)), f.argv("list", "--page-size", "100")]) await assert.rejects(executeCommand(args, fetchImpl));
  assert.deepEqual(tokens, []); assert.equal(f.server.calls.length, 0);
  const first = await executeCommand(f.argv("list", "--status", "TASK_STATE_WORKING"), fetchImpl) as { nextPageToken: string };
  assert.deepEqual(tokens, [""]);
  await executeCommand(f.argv("list", "--status", "TASK_STATE_WORKING", "--page-token", first.nextPageToken), fetchImpl);
  assert.deepEqual(tokens, ["", "next&opaque"]); assert.equal(f.files.read("ledger.json"), undefined);
});
test("file bounds and kinds fail before journal/network", async t => {
  const f = fixture(); t.after(f.cleanup);
  const ordinary = f.input({ parts: [{ text: "x" }] }), link = join(f.base, "link"), dir = join(f.base, "directory");
  symlinkSync(ordinary, link); mkdirSync(dir);
  for (const path of [link, dir]) await assert.rejects(executeCommand(f.argv("send", "--recipient", "other/sender", "--input", path), f.server.fetch));
  for (const text of ["not JSON", "x".repeat(256 * 1024 + 1)]) {
    writeFileSync(ordinary, text); await assert.rejects(executeCommand(f.argv("send", "--recipient", "other/sender", "--input", ordinary), f.server.fetch));
  }
  assert.equal(f.server.calls.length, 0); assert.equal(f.files.read("ledger.json"), undefined);
});
test("lost lock fences writes, preserves original send IDs and closes descriptors", async t => {
  const f = fixture(); t.after(f.cleanup); let posts = 0;
  const output: string[] = [];
  const code = await main(f.argv("send", "--recipient", "other/sender", "--input", f.input({ parts: [{ text: "x" }], taskId: "00000000-0000-4000-8000-000000000001" }), "--json"), undefined, s => output.push(s), { fetchImpl: async (url, init) => {
    if (init?.method === "POST") {
      posts++; renameSync(join(f.root, "consumer.json"), join(f.root, "old-lock.json"));
      writeFileSync(join(f.root, "consumer.json"), "{}", { mode: 0o600 });
    }
    return f.server.fetch(url, init);
  } });
  assert.equal(code, 1); assert.equal(posts, 1);
  const error = JSON.parse(output[0]), stored = Object.values(f.files.read<Ledger>("ledger.json")!.outgoing)[0];
  assert.equal(error.messageId, stored.messageId); assert.equal(error.taskId, "00000000-0000-4000-8000-000000000001"); assert.equal(error.recipient, "other/sender"); assert.equal(error.uncertain, true); assert.equal(stored.phase, "prepared");
  const release = f.files.acquire(); release();
});
test("accepted send and reply remain success when final local save fails", async t => {
  for (const command of ["send", "reply"] as const) {
    const f = fixture(); t.after(f.cleanup); let writes = 0;
    const args = command === "send" ? ["--recipient", "other/sender"] : ["--task-id", "00000000-0000-4000-8000-000000000001"];
    const body = command === "send" ? { parts: [{ text: "x" }] } : { state: "TASK_STATE_COMPLETED" };
    const lines: string[] = [];
    assert.equal(await main(f.argv(command, ...args, "--input", f.input(body), "--json"), undefined, s => lines.push(s), { fetchImpl: async (url, init) => {
      const result = await f.server.fetch(url, init);
      if (init?.method === "POST" || init?.method === "PATCH") {
        writes++; renameSync(join(f.root, "ledger.json"), join(f.root, "saved-ledger.json")); mkdirSync(join(f.root, "ledger.json"), { mode: 0o700 });
      }
      return result;
    } }), 0);
    const result = JSON.parse(lines[0]).result; assert.match(result.warning, /accepted/); assert.equal(writes, 1);
    assert.equal((result.result ?? result.task).id, "00000000-0000-4000-8000-000000000001"); const release = f.files.acquire(); release();
  }
});
test("receipt reconciliation proves Task or direct Message acceptance without resending", async t => {
  for (const direct of [false, true]) {
    const f = fixture(); t.after(f.cleanup); f.server.rpcFailure = "lost";
    await assert.rejects(executeCommand(f.argv("send", "--recipient", "other/sender", "--input", f.input({ parts: [{ text: "x" }] })), f.server.fetch));
    const id = Object.keys(f.files.read<Ledger>("ledger.json")!.outgoing)[0]; f.server.rpcFailure = undefined; let queries = 0;
    const result = await executeCommand(f.argv("reconcile-send", "--message-id", id), async (url, init) => {
      if (init?.method === "POST") {
        queries++; assert.match(String(url), /concourse\/network-1$/); const body = JSON.parse(String(init.body));
        assert.deepEqual(body.params.message.parts[0].data, { operation: "delivery", recipient: "other/sender", messageId: id });
        const data = direct ? { accepted: true, resultType: "message", state: "delivered", taskStatus: null } : { accepted: true, resultType: "task", taskId: "00000000-0000-4000-8000-000000000001" };
        return response({ jsonrpc: "2.0", id: body.id, result: { message: { messageId: "receipt1", role: "ROLE_AGENT", parts: [{ data }] } } });
      }
      return f.server.fetch(url, init);
    }) as { phase: string; directResultUnavailable?: boolean; taskId?: string };
    assert.equal(queries, 1); assert.equal(result.phase, "accepted");
    assert.equal(result.directResultUnavailable, direct ? true : undefined); assert.equal(result.taskId, direct ? undefined : "00000000-0000-4000-8000-000000000001");
    assert.equal(f.files.read<Ledger>("ledger.json")!.outgoing[id].phase, "accepted");
  }
});
test("human output is a summary; JSON preserves peer payload, artifacts use server-assigned IDs", async t => {
  const f = fixture(); t.after(f.cleanup);
  const artifact = { parts: [{ data: { answer: true } }], metadata: { source: "test" }, extensions: ["urn:test"] };
  const args = f.argv("reply", "--task-id", "00000000-0000-4000-8000-000000000001", "--input", f.input({ state: "TASK_STATE_COMPLETED", parts: [{ text: "private-peer-content\u001b[31m" }], artifacts: [artifact] }));
  const human: string[] = []; assert.equal(await main(args, undefined, s => human.push(s), { fetchImpl: f.server.fetch }), 0);
  assert.ok(!human[0].includes("private-peer-content")); assert.ok(!human[0].includes("\u001b")); assert.match(human[0], /00000000-0000-4000-8000-000000000001/);
  const lines: string[] = []; assert.equal(await main(f.argv("task", "--task-id", "00000000-0000-4000-8000-000000000001", "--json"), undefined, s => lines.push(s), { fetchImpl: f.server.fetch }), 0);
  assert.equal(JSON.parse(lines[0]).result.status.message.parts[0].text, "private-peer-content\u001b[31m");
  const patch = f.server.calls.find(c => c.method === "PATCH")!; assert.deepEqual(patch.body.artifacts, [artifact]);
  const source = readFileSync(new URL("../src/commands.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["'].*(?:runtime|mailbox|doorbell)|setInterval|setTimeout|\.sweep\(|\.enqueue\(/);
});
