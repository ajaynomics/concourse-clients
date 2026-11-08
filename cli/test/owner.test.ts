import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ownerRoute } from "../src/owner.ts";
import { cli, json, noNetwork, profile, Server } from "./fixture.ts";

function setup(t: TestContext) {
  noNetwork(t);
  const p = profile(t), server = new Server();
  return { ...p, server, run: (argv: string[]) => cli(argv, { home: p.home, fetchImpl: server.fetch }) };
}
const entry = (status: string) => ({ id: 12, address: "peer/agent", status });

test("owner actions call the documented REST endpoints after checking identity", async t => {
  const f = setup(t);
  f.server.routes.set("GET /api/pending_agents", () => json({ agents: [{ id: 12, address: "peer/agent", name: "Peer", owner: "someone", client_id: "c1", requested_at: "2026-11-08T12:00:00Z" }] }));
  f.server.routes.set("POST /api/agents/12/approval", () => json(entry("admitted")));
  f.server.routes.set("DELETE /api/pending_agents/12", () => json(entry("declined")));
  f.server.routes.set("POST /api/agents/12/retirement", () => json(entry("declined")));

  const pending = await f.run(["pending"]);
  assert.equal(pending.code, 0);
  assert.equal(pending.text, "   12  peer/agent  Peer  requested 2026-11-08T12:00:00Z by someone\nApprove with: concourse approve ID. Decline with: concourse decline ID.");
  assert.equal((await f.run(["approve", "12"])).text, "Approved peer/agent (id 12). Status: admitted.");
  assert.equal((await f.run(["decline", "12"])).text, "Declined peer/agent (id 12). Status: declined.");
  const retired = await f.run(["retire", "12", "--json"]);
  assert.deepEqual(retired.last(), { phase: "complete", command: "retire", result: entry("declined") });
  assert.deepEqual(f.server.paths(), [
    "GET /api/identity", "GET /api/pending_agents", "GET /api/identity", "POST /api/agents/12/approval",
    "GET /api/identity", "DELETE /api/pending_agents/12", "GET /api/identity", "POST /api/agents/12/retirement",
  ]);
  assert.ok(f.server.calls.every(c => c.body === undefined));

  f.server.routes.set("GET /api/pending_agents", () => json({ agents: [] }));
  assert.equal((await f.run(["pending"])).text, "No agents are waiting for approval.");
});

test("an unnamed agent's null address is a valid answer", async t => {
  const f = setup(t);
  f.server.routes.set("GET /api/pending_agents", () => json({ agents: [{ id: 13, address: null, name: "New app", owner: "someone", client_id: "c2", requested_at: "2026-11-08T12:00:00Z" }] }));
  f.server.routes.set("POST /api/agents/13/approval", () => json({ id: 13, address: null, status: "admitted" }));
  assert.match((await f.run(["pending"])).text, /^ {3}13 {2}\(unnamed\)/);
  const approved = await f.run(["approve", "13"]);
  assert.equal(approved.code, 0);
  assert.equal(approved.text, "Approved (unnamed agent) (id 13). Status: admitted.");
});

test("documented refusals map to plain, stable errors", async t => {
  const f = setup(t);
  const cases = [
    ["approve", 403, "machine_client", "Only an agent its person signed in can act for them. An app's unattended credential cannot.", "MACHINE_CLIENT"],
    ["retire", 403, "owner_required", "Only an owner of this organization can do this, through their own agent.", "OWNER_REQUIRED"],
    ["pending", 403, "owner_required", "Only an owner of this organization can do this, through their own agent.", "OWNER_REQUIRED"],
    ["approve", 404, "not_found", undefined, "AGENT_NOT_FOUND"],
    ["decline", 422, "not_pending", "This agent is admitted. Retire it instead.", "NOT_PENDING"],
    ["retire", 422, "self_retirement", "An agent cannot retire itself. An app disconnects with POST /connect/revoke.", "SELF_RETIREMENT"],
  ] as const;
  for (const [action, status, error, message, code] of cases) {
    const route = ownerRoute(action, "12");
    f.server.routes.set(`${route.method} /${route.path}`, () => json({ error, ...(message ? { message } : {}) }, status));
    const argv = action === "pending" ? [action] : [action, "12"];
    const machine = await f.run([...argv, "--json"]);
    assert.equal(machine.code, 1);
    assert.deepEqual({ ...machine.last(), recovery: undefined }, { phase: "blocked", error: code, uncertain: false, status, reason: error, recovery: undefined });
    const human = await f.run(argv);
    assert.equal(human.out.length, 0);
    assert.match(human.err[0], new RegExp(`^Error: ${code}\\n${(message ?? "No such agent in your organization.").replace(/[.()/]/g, "\\$&")}`));
  }
  f.server.routes.set("POST /api/agents/12/approval", () => json({ error: "machine_client", message: "Only an agent its person signed in can act for them." }, 403));
  const machineClient = await f.run(["approve", "12"]);
  assert.match(machineClient.err[0], /Use a profile its owner signed in for with concourse join or concourse login\./);
});

test("server text is sanitized; unknown refusals keep their HTTP code; unknown writes stay uncertain", async t => {
  const f = setup(t);
  f.server.routes.set("POST /api/agents/12/approval", () => json({ error: "owner_required", message: "Owners only\u001b[2J\u202e" }, 403));
  const hostile = await f.run(["approve", "12"]);
  assert.match(hostile.err[0], /^Error: OWNER_REQUIRED\nOwners only\uFFFD\[2J\uFFFD /); assert.doesNotMatch(hostile.err[0], /\u001b|\u202e/);

  f.server.routes.set("POST /api/agents/12/approval", () => json({ error: "machine_client" }, 422));
  assert.deepEqual(pick((await f.run(["approve", "12", "--json"])).last()), ["HTTP_REFUSED_422", false, "machine_client"]);
  f.server.routes.set("POST /api/agents/12/approval", () => json({ error: "something_new" }, 403));
  assert.deepEqual(pick((await f.run(["approve", "12", "--json"])).last()), ["HTTP_REFUSED_403", false, "something_new"]);

  f.server.routes.set("POST /api/agents/12/approval", () => json({}, 503));
  const outage = (await f.run(["approve", "12", "--json"])).last();
  assert.deepEqual(pick(outage), ["HTTP_REFUSED_503", true, undefined]); assert.match(outage.recovery, /may have applied it/);
  f.server.routes.set("POST /api/agents/12/approval", () => { throw new Error("synthetic connection reset"); });
  assert.deepEqual(pick((await f.run(["approve", "12", "--json"])).last()), ["TRANSPORT_FAILED", true, undefined]);
  f.server.routes.set("POST /api/agents/12/approval", () => json({ ok: true }));
  assert.deepEqual(pick((await f.run(["approve", "12", "--json"])).last()), ["INVALID_OWNER_RESPONSE", true, undefined]);
  f.server.routes.set("GET /api/pending_agents", () => json({}, 503));
  assert.deepEqual(pick((await f.run(["pending", "--json"])).last()), ["HTTP_REFUSED_503", false, undefined], "a failed read is not uncertain");
  assert.equal(f.server.calls.filter(c => c.method === "POST").length, 6, "one request per command, never a retry");
});
const pick = (v: Record<string, unknown>) => [v.error, v.uncertain, v.reason];

test("an identity mismatch stops before any owner action", async t => {
  const f = setup(t);
  f.server.routes.set("GET /api/identity", () => json({ release_line: 3, organization: "test", owner: "owner", handle: "someone-else", oauth_client_id: "synthetic-client", agent_id: 7, network_agent: "concourse/network-1" }));
  const r = await f.run(["approve", "12", "--json"]);
  assert.equal(r.code, 1); assert.equal(r.last().error, "V3_IDENTITY_REFUSED");
  assert.deepEqual(f.server.paths(), ["GET /api/identity"]);
});
