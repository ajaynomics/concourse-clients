import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Client } from "../src/client.ts";
import { Replies } from "../src/replies.ts";
import { Outbox } from "../src/outgoing.ts";
import { SafeError, type Fetch } from "../src/http.ts";
import { Memory } from "./helpers.ts";
import { config, syntheticToken, task, WireFixture } from "./sdk-seams-fixture-20261012.ts";

// 18 Nov 2026: sends and replies came back "unknown" and had never reached the server.
// A client reuses an idle keep-alive connection; if the server has just closed it, the
// write is lost before the server reads it, and fetch retries only reads.
// This real HTTP server fronts the usual WireFixture and plays that race: a write arriving
// on a socket that already carried a request is dropped unread, as on a connection the
// server had just closed.
async function staleServer(t: { after(fn: () => unknown): void }) {
  const wire = new WireFixture(), used = new WeakSet<Socket>(), writes: boolean[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reused = used.has(req.socket); used.add(req.socket);
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    if (req.method !== "GET") { writes.push(reused); if (reused) { req.socket.destroy(); return; } }
    const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
    const r = await wire.fetch(`${config.origin}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body, redirect: "error" });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The client insists on its https origin; only this test maps it to the local server.
  const fetchImpl: Fetch = async (input, init) => {
    const r = await fetch(String(input instanceof Request ? input.url : input).replace(config.origin, base), init);
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const client = new Client(config, async () => syntheticToken, fetchImpl);
  // Polling leaves idle connections behind; give the pool two of them.
  await Promise.all([client.identity(), client.identity()]); await new Promise(r => setTimeout(r, 50));
  return { wire, writes, client };
}

test("a reply goes out on a connection of its own, so a stale idle one cannot lose it", { timeout: 10000 }, async t => {
  const s = await staleServer(t), journal = new Memory();
  s.wire.current = task("TASK_STATE_COMPLETED");
  const result = await new Replies(journal, s.client).send(s.wire.current.id, { state: "TASK_STATE_COMPLETED", parts: [{ text: "done" }] });
  assert.equal("task" in result ? result.task.id : result.id, s.wire.current.id);
  assert.deepEqual(Object.values(journal.value.replies ?? {}).map(r => r.phase), ["accepted"]);
  assert.deepEqual(s.writes, [false], "the write used a connection of its own");
});

test("an A2A send goes out on a connection of its own, so a stale idle one cannot lose it", { timeout: 10000 }, async t => {
  const s = await staleServer(t), journal = new Memory();
  const result = await new Outbox(journal, s.client).send("other/sender", [{ text: "hello" }]);
  assert.ok(result);
  assert.deepEqual(Object.values(journal.value.outgoing).map(o => o.phase), ["accepted"]);
  assert.deepEqual(s.writes, [false], "the write used a connection of its own");
});

test("a write lost on the network stays unknown, and the ledger keeps the network error code", async () => {
  const lost = new SafeError("TRANSPORT_FAILED", true, undefined, { network: "UND_ERR_SOCKET" });
  const journal = new Memory();
  await assert.rejects(new Replies(journal, { reply: async () => { throw lost; } }).send("t1", { state: "TASK_STATE_COMPLETED" }), /REPLY_UNCONFIRMED.*network=UND_ERR_SOCKET.*outcome unknown/);
  assert.deepEqual(Object.values(journal.value.replies ?? {}).map(r => [r.phase, r.network]), [["uncertain", "UND_ERR_SOCKET"]]);
  const outbox = new Outbox(journal, { send: async () => { throw lost; } } as unknown as Client);
  await assert.rejects(outbox.send("owner/peer", [{ text: "hello" }]), /SEND_UNCONFIRMED_OR_REFUSED.*network=UND_ERR_SOCKET.*outcome unknown/);
  assert.deepEqual(Object.values(journal.value.outgoing).filter(o => o.phase === "uncertain").map(o => o.network), ["UND_ERR_SOCKET"]);
});

test("the network code comes from the error's cause, never its message", async () => {
  const { safeFetch } = await import("../src/http.ts");
  const socket = Object.assign(new Error("other side closed private-detail"), { code: "UND_ERR_SOCKET" });
  const failing: Fetch = async () => { throw new TypeError("fetch failed private-detail", { cause: socket }); };
  const e = await safeFetch(config.origin, failing)(`${config.origin}/api/tasks/x`, { method: "PATCH", body: "{}" }).catch(e => e);
  assert.ok(e instanceof SafeError); assert.equal(e.code, "TRANSPORT_FAILED"); assert.equal(e.uncertain, true);
  assert.deepEqual(e.details, { network: "UND_ERR_SOCKET" }); assert.doesNotMatch(e.message, /private-detail/);
  const timeout: Fetch = async () => { throw new DOMException("timed out private-detail", "TimeoutError"); };
  const t2 = await safeFetch(config.origin, timeout)(`${config.origin}/api/tasks/x`, { method: "PATCH", body: "{}" }).catch(e => e);
  assert.deepEqual(t2.details, { network: "TIMEOUT" });
});
