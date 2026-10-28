import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/client.ts";
import { SafeError } from "../src/http.ts";
import { card, config, endpoint, outboundGuard, syntheticToken, task, WireFixture } from "./sdk-seams-fixture-20261012.ts";
import type { ObjectValue } from "../src/types.ts";

// This exercises ClientFactory → SDK Client → JsonRpcTransport. No SDK method is stubbed.
// A2A v1.0 §3.1.1/§3.3.1: Task and direct Message remain distinct; unknown writes are not retried.
function fixture() {
  const server = new WireFixture(), guard = outboundGuard();
  const client = new Client(config, async () => syntheticToken, server.fetch);
  return { server, guard, client };
}

test("real a2aSDK1.3 JSONRPC emits v1/header/security card and immediate Task without polling", async t => {
  const f = fixture(); t.after(() => f.guard.close());
  const value = task("TASK_STATE_WORKING");
  value.history![0].parts = [{ text: "Retained input" }, { mediaType: "application/json", data: { nested: { evidence: [1, 2] } } }];
  f.server.rpcResult = { task: value };
  const parts: ObjectValue[] = [{ text: "Decisive Unicode input λ" }, { data: { input: [1, { exact: true }] } }];
  assert.deepEqual(await f.client.send("other/sender", "stable-message-id", parts, "task1", "context1"), value);
  const post = f.server.calls.find(c => c.method === "POST")!;
  assert.equal(post.body.params.message.messageId, "stable-message-id");
  assert.equal(post.body.params.message.taskId, "task1"); assert.equal(post.body.params.message.contextId, "context1");
  assert.equal(post.body.params.message.role, "ROLE_USER");
  assert.deepEqual(post.body.params.message.parts, [{ text: parts[0].text, mediaType: "text/plain" }, { data: parts[1].data, mediaType: "application/json" }]);
  assert.deepEqual(post.body.params.configuration.acceptedOutputModes, ["text/plain", "application/json"]);
  assert.equal(post.body.params.configuration.returnImmediately, true);
  assert.equal(post.headers.get("A2A-Version"), "1.0");
  assert.deepEqual(card().securityRequirements, [{ schemes: { oauth2: { list: ["concourse"] } } }]);
  assert.deepEqual(f.server.calls.map(c => new URL(c.url).pathname), ["/api/identity", "/a2a/test/other/sender/.well-known/agent-card.json", "/a2a/test/other/sender"]);
  assert.equal(f.server.unsupported, 0);
});

test("real SDK direct Message preserves IDs/text/DataParts/artifact-free shape; network data is not a Task", async t => {
  const f = fixture(); t.after(() => f.guard.close());
  const direct = { messageId: "direct-answer-id", contextId: "direct-context", role: "ROLE_AGENT", parts: [{ text: "Actual direct answer" }, { mediaType: "application/json", data: { answer: { n: 7 } }, metadata: { provenance: "synthetic" } }], metadata: { exact: true } };
  f.server.rpcResult = { message: direct };
  const result = await f.client.send("other/sender", "direct-request", [{ data: { operation: "query" } }]);
  assert.deepEqual(result, direct); assert.ok(!("status" in (result as object))); assert.ok(!("taskId" in (result as object)));
  const network = await f.client.network({ operation: "presence", agent: "other/sender" });
  assert.deepEqual(network, { operation: "presence", agent: "other/sender", state: "connected", observedAt: null, leaseExpiresAt: null, fresh: false });
  const post = f.server.calls.filter(c => c.method === "POST").at(-1)!;
  assert.equal(post.url, endpoint("concourse/network-1"));
  assert.deepEqual(post.body.params.message.parts, [{ mediaType: "application/json", data: { operation: "presence", agent: "other/sender" } }]);
  assert.equal(f.server.unsupported, 0);
});

test("real SDK unknown write/refusal/invalid response has one POST and no hidden follow-up or retries", async t => {
  const guard = outboundGuard(); t.after(() => guard.close());
  for (const failure of ["lost", "500", "401", "bad-id"] as const) {
    const server = new WireFixture(); server.rpcFailure = failure;
    const client = new Client(config, async () => syntheticToken, server.fetch);
    await assert.rejects(client.send("other/sender", `original-${failure}`, [{ text: "One synthetic operation" }]), (e: unknown) => e instanceof SafeError && (failure === "401" ? !e.uncertain : e.uncertain));
    assert.equal(server.calls.filter(c => c.method === "POST").length, 1, failure);
    assert.equal(server.calls.length, 3, "identity + exact card + single SendMessage only");
    assert.equal(server.unsupported, 0);
  }
});

test("malicious interface origin/cardURL/path/version is rejected before any bearer reaches selected destination", async t => {
  const guard = outboundGuard(); t.after(() => guard.close());
  const variants = [
    { url: "https://attacker.invalid/capture" },
    { url: `${config.origin}/api/identity` },
    { url: `${endpoint()}/.well-known/agent-card.json` },
    { url: `${endpoint()}?cardURL=https://attacker.invalid/capture` },
    { protocolVersion: "0.3" }, { protocolVersion: "1.1" }, { protocolBinding: "HTTP+JSON" },
  ];
  for (const change of variants) {
    const server = new WireFixture(); server.cardOverride = card(); Object.assign(server.cardOverride.supportedInterfaces[0], change);
    const client = new Client(config, async () => syntheticToken, server.fetch);
    await assert.rejects(client.send("other/sender", "never-written", [{ text: "Synthetic input" }]), /A2A_CARD_VERSION_OR_DESTINATION_REFUSED/);
    assert.deepEqual(server.calls.map(c => c.method), ["GET", "GET"]);
    assert.equal(server.calls[1].url, `${endpoint()}/.well-known/agent-card.json`);
    assert.equal(server.unsupported, 0, "no attempted leak to card-selected destination");
  }
});

test("card redirect is never followed; wrong identity/release stops before card or A2A bearer use", async t => {
  const guard = outboundGuard(); t.after(() => guard.close());
  const server = new WireFixture(); server.cardResponse = new Response(null, { status: 302, headers: { location: "https://attacker.invalid/card" } });
  const client = new Client(config, async () => syntheticToken, server.fetch);
  await assert.rejects(client.send("other/sender", "redirect-request", [{ text: "Synthetic" }]), /REDIRECT_REFUSED/);
  assert.equal(server.calls.length, 2); assert.equal(server.calls.filter(c => c.method === "POST").length, 0);
  for (const identityChange of [{ release_line: 1 }, { organization: "wrong-org" }, { oauth_client_id: "wrong-client" }]) {
    const calls: string[] = [];
    const bad = new Client(config, async () => syntheticToken, async (input, init) => {
      const url = String(input); calls.push(url); assert.equal(url, `${config.origin}/api/identity`);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${syntheticToken}`);
      const { identity } = await import("./helpers.ts");
      return new Response(JSON.stringify({ ...identity, ...identityChange }), { headers: { "content-type": "application/json" } });
    });
    await assert.rejects(bad.send("other/sender", "wrong-binding", [{ text: "Synthetic" }]), /V3_IDENTITY_REFUSED/);
    assert.equal(calls.length, 1);
  }
});
