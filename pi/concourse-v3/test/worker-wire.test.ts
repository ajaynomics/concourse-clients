import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/client.ts";
import { config, identity, outboundGuard, syntheticToken, WireFixture } from "./sdk-seams-fixture-20261012.ts";

function fixture() {
  const server = new WireFixture(); server.sessionId = "session1";
  const guard = outboundGuard();
  const client = new Client(config, async () => syntheticToken, server.fetch);
  return { server, guard, client };
}

test("worker inbox requires actual bounded paging and passes the opaque cursor", async t => {
  const f = fixture(); t.after(() => f.guard.close());
  assert.equal((await f.client.inbox()).nextPageToken, "sdk-page-2");
  assert.equal((await f.client.inbox("sdk-page-2")).nextPageToken, undefined);
  assert.deepEqual(f.server.pageTokens, ["", "sdk-page-2"]);
  const client = new Client(config, async () => syntheticToken, async input => new Response(JSON.stringify(String(input).endsWith("api/identity") ? identity : { tasks: [] }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(client.inbox(), /V3_BOUNDED_INBOX_CONTRACT_REQUIRED/);
});
