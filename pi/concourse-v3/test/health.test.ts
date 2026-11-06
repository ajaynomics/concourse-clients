import assert from "node:assert/strict";
import test from "node:test";
import { statSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "../src/auth.ts";
import { Client, TaskReadError } from "../src/client.ts";
import { Health, channelState, type HealthSnapshot } from "../src/health.ts";
import { SafeError, type Fetch } from "../src/http.ts";
import { Runtime } from "../src/runtime.ts";
import { PrivateFiles } from "../src/storage.ts";
import { config, identity, profile, response, task } from "./helpers.ts";

function fixture(c: Config = config) {
  const p = profile(), warnings: string[] = [], events: string[] = [];
  let identityFails = false, tailFails = false, headFails = false;
  p.files.write("tokens.json", { access: "synthetic", expires: Date.now() + 3600_000, resource: c.origin, issuer: c.issuer, clientId: c.oauthClientId });
  const fetchImpl: Fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === "/api/identity") return response({ ...identity, organization: c.organization, owner: c.owner, handle: c.agent }, identityFails ? 503 : 200);
    if (url.pathname === "/api/doorbell") return response({}, 403);
    assert.equal(url.pathname, "/agents/1/tasks");
    if (url.searchParams.has("pageToken")) { events.push("tail"); if (tailFails) throw new Error("PRIVATE tail data"); }
    else { events.push("head"); if (headFails) throw new Error("PRIVATE head data"); }
    return response({ tasks: url.searchParams.has("pageToken") ? [] : [task()], nextPageToken: "" });
  };
  const ctx = { sessionManager: { getSessionId: () => "synthetic-session" }, ui: { setStatus: () => {}, notify: (text: string, level: string) => { assert.equal(level, "warning"); warnings.push(text); } } } as unknown as ExtensionContext;
  const pi = { sendMessage: () => events.push("handoff") } as unknown as ExtensionAPI;
  const runtime = new Runtime({ pi, fetchImpl, current: () => true, labelled: () => true }, ctx, p.files, c, "test");
  return { p, runtime, warnings, events, health: () => p.files.read<HealthSnapshot>("health.json")!,
    identityFails: (v: boolean) => { identityFails = v; }, tailFails: (v: boolean) => { tailFails = v; }, headFails: (v: boolean) => { headFails = v; },
    close: async () => { await runtime.stop(); p.cleanup(); } };
}

test("bounded inbox tail failure preserves head handoff and independent answer sweep", async () => {
  const f = fixture();
  try {
    const l = f.runtime.journal.load(); l.cursors.inbox = "private-cursor"; f.runtime.journal.save(l);
    f.runtime.outbox.sweep = async () => { f.events.push("answers"); };
    f.tailFails(true);
    await assert.rejects(f.runtime.refresh(), /TRANSPORT_FAILED/);
    assert.deepEqual(f.events, ["head", "handoff", "tail", "answers"]);
    const h = f.health(); assert.equal(h.identity.state, "ok"); assert.equal(h.inbox.state, "failed"); assert.equal(h.answers.state, "ok");
    assert.equal(h.inbox.code, "TRANSPORT_FAILED"); assert.ok(h.inbox.failureStartedAt);
    assert.equal(f.runtime.journal.load().cursors.inbox, "private-cursor");
    f.tailFails(false); await f.runtime.refresh();
    assert.equal(f.health().inbox.state, "ok"); assert.equal(f.health().inbox.failureStartedAt, undefined);
  } finally { await f.close(); }
});

test("answers fail independently; successful sweep cannot conceal quarantined tasks", async () => {
  const f = fixture();
  try {
    f.runtime.outbox.sweep = async () => { throw new TaskReadError(new SafeError("TRANSPORT_FAILED")); };
    await assert.rejects(f.runtime.refresh(), /TRANSPORT_FAILED/);
    assert.equal(f.health().inbox.state, "ok"); assert.equal(f.health().answers.state, "failed");
    const l = f.runtime.journal.load(); l.blockedInbox = { "PRIVATE task": { code: "INBOX_TASK_TOO_LARGE" } }; l.blockedAnswers = { "PRIVATE answer": { code: "RESPONSE_TOO_LARGE" } }; f.runtime.journal.save(l);
    f.runtime.outbox.sweep = async () => {}; await f.runtime.refresh();
    const h = f.health(); assert.equal(h.blockedInbox, 1); assert.equal(h.blockedAnswers, 1);
    assert.equal(h.answers.state, "ok"); assert.equal(channelState(h, "answers"), "blocked"); assert.equal(channelState(h, "inbox"), "blocked");
    assert.doesNotMatch(JSON.stringify(h), /PRIVATE|private-cursor|messageId|taskId|tokens|synthetic-not-a-credential/);
  } finally { await f.close(); }
});

test("identity failure never becomes inbox or answers success", async () => {
  const f = fixture();
  try {
    f.identityFails(true); f.runtime.outbox.sweep = async () => { throw new Error("must not sweep"); };
    await assert.rejects(f.runtime.refresh(), /HTTP_REFUSED_503/);
    assert.equal(f.health().identity.state, "failed"); assert.equal(f.health().inbox.state, "failed"); assert.equal(f.health().answers.state, "unknown"); assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});

test("unknown, stopped, stale and generation reset are not healthy; storage is private and owned", () => {
  const p = profile(); let now = 1000; const release = p.files.acquire();
  try {
    const h = new Health(p.files, config, "synthetic-session", () => {}, () => now);
    h.write(); assert.equal(channelState(h.snapshot, "identity", now), "unknown");
    h.attempt("identity"); h.success("identity"); assert.equal(channelState(h.snapshot, "identity", now), "ok");
    assert.equal(channelState(h.snapshot, "identity", now + h.snapshot.staleAfterMs + 1), "stale");
    h.attempt("answers"); h.failure("answers", new Error("PRIVATE token URL?query and peer content"));
    assert.equal(h.snapshot.answers.code, "LOCAL_OPERATION_FAILED");
    h.failure("answers", new SafeError("PRIVATE text not a code")); assert.equal(h.snapshot.answers.code, "LOCAL_OPERATION_FAILED");
    assert.doesNotMatch(JSON.stringify(p.files.read("health.json")), /PRIVATE|query|peer/);
    assert.equal(statSync(join(p.root, "health.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(p.root, "health.json")).uid, process.getuid!());
    h.stop(); assert.equal(channelState(h.snapshot, "identity", now), "stopped");
    now++; const next = new Health(p.files, config, "synthetic-session", () => {}, () => now); next.write();
    assert.notEqual(next.snapshot.generation, h.snapshot.generation); assert.equal(next.snapshot.identity.lastSuccessAt, undefined);
    release(); assert.throws(() => next.write(), /HEALTH_OWNERSHIP_LOST/);
  } finally { release(); p.cleanup(); }
});

test("health persistence failure fences generation before reads; no network reclassification", async () => {
  const f = fixture(), write = f.p.files.write.bind(f.p.files);
  try {
    f.p.files.write = (name, value) => { if (name === "health.json") throw new Error("PRIVATE disk details"); write(name, value); };
    await assert.rejects(f.runtime.refresh(), /HEALTH_PERSISTENCE_FAILED/);
    assert.equal(f.runtime.life.alive(), false); assert.deepEqual(f.events, []);
    assert.throws(() => f.runtime.refresh(), /SESSION_REPLACED/);
  } finally { f.p.files.write = write; await f.close(); }
});

test("replaced consumer lock cannot write health or continue I/O, including shutdown", async () => {
  const f = fixture();
  renameSync(join(f.p.root, "consumer.json"), join(f.p.root, "old-consumer.json"));
  assert.throws(() => f.runtime.refresh(), /SESSION_REPLACED/);
  await f.runtime.stop();
  assert.deepEqual(f.events, []); f.p.cleanup();
});

const oauth: Config = { ...config, auth: { kind: "oauth", redirectUri: "http://127.0.0.1:23456/callback" }, authorizationEndpoint: "https://issuer.invalid/authorize" };
for (const fence of [true, { unknownShape: "PRIVATE" }]) test(`OAuth fence warning at startup with valid access, deduped (${typeof fence})`, async () => {
  const f = fixture(oauth);
  try {
    f.p.files.write("oauth-exchange.json", fence); f.runtime.start();
    await f.runtime.client.identity(); await f.runtime.client.identity();
    assert.equal(f.warnings.length, 1); assert.match(f.warnings[0], /concourse.invalid · owner\/recipient · test/);
    assert.match(f.warnings[0], /terminal run script\/concourse-v3 login --profile/); assert.doesNotMatch(f.warnings[0], /(?:^|\s)\/concourse-v3 login|PRIVATE|tokens|config.json/);
    assert.deepEqual(f.p.files.read("oauth-exchange.json"), fence);
    assert.equal(f.health().oauthCode, "OAUTH_EXCHANGE_UNCERTAIN"); assert.equal(channelState(f.health(), "identity"), "blocked");
    f.p.files.write("oauth-exchange.json", false); await f.runtime.client.identity();
    f.p.files.write("oauth-exchange.json", fence); await f.runtime.client.identity(); assert.equal(f.warnings.length, 2);
    assert.deepEqual(f.events, [], "warning itself starts no model turn");
  } finally { await f.close(); }
});

test("health follows the token client's exchange state; a reported uncertain exchange still warns", async () => {
  const f = fixture(oauth);
  try {
    f.runtime.start(); let state: ReturnType<typeof f.runtime.tokens.exchangeState> = "resumable";
    f.runtime.tokens.exchangeState = () => state;
    await f.runtime.client.identity(); assert.equal(f.warnings.length, 0); assert.equal(f.health().oauthCode, undefined);
    f.runtime.tokens.token = async () => { throw new SafeError("OAUTH_EXCHANGE_UNCERTAIN", true); };
    await assert.rejects(f.runtime.client.identity(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(f.warnings.length, 1); assert.equal(f.health().oauthCode, "OAUTH_EXCHANGE_UNCERTAIN");
    state = "refused"; await assert.rejects(f.runtime.client.identity());
    assert.equal(f.health().oauthCode, "OPERATOR_OAUTH_REQUIRED");
  } finally { await f.close(); }
});

test("operator-required warning dedupes and labels different organizations", async () => {
  const all: string[] = [];
  for (const organization of ["team-one", "team-two"]) {
    const f = fixture({ ...oauth, organization });
    try {
      f.runtime.tokens.token = async () => { throw new SafeError("OPERATOR_OAUTH_REQUIRED"); };
      await assert.rejects(f.runtime.client.identity(), /OPERATOR_OAUTH_REQUIRED/);
      await assert.rejects(f.runtime.client.identity(), /OPERATOR_OAUTH_REQUIRED/);
      assert.equal(f.warnings.length, 1); assert.match(f.warnings[0], new RegExp(organization)); all.push(f.warnings[0]);
      assert.equal(f.health().identity.state, "failed"); assert.equal(f.health().oauthCode, "OPERATOR_OAUTH_REQUIRED");
    } finally { await f.close(); }
  }
  assert.notEqual(all[0], all[1]);
});

test("identity observations validate the body, and observation failure never publishes", async () => {
  const states: string[] = [];
  const client = new Client(config, async () => "synthetic", async () => response({ ...identity, owner: "wrong" }), () => true, event => states.push(event.state));
  await assert.rejects(client.identity(), /V3_IDENTITY_REFUSED/); assert.deepEqual(states, ["attempt", "failure"]);
  let writes = 0;
  const guarded = new Client(config, async () => "synthetic", async (_input, init) => { if (init?.method !== "GET") writes++; return response(identity); }, () => true, event => { if (event.state === "success") throw new SafeError("HEALTH_PERSISTENCE_FAILED"); });
  await assert.rejects(guarded.reply("synthetic-task", { state: "TASK_STATE_WORKING" }), /HEALTH_PERSISTENCE_FAILED/); assert.equal(writes, 0);
});

test("a fresh identity write after clock rollback cannot refresh future inbox observations", () => {
  const p = profile(); let now = 2000; const release = p.files.acquire();
  try {
    const h = new Health(p.files, config, "synthetic-session", () => {}, () => now);
    for (const channel of ["identity", "inbox", "answers"] as const) { h.attempt(channel); h.success(channel); }
    now = 1500; h.attempt("identity"); h.success("identity");
    assert.equal(channelState(h.snapshot, "identity", now), "ok");
    assert.equal(channelState(h.snapshot, "inbox", now), "stale");
    assert.equal(channelState(h.snapshot, "answers", now), "stale");
  } finally { release(); p.cleanup(); }
});

test("final health persistence failure releases the profile without poisoning shutdown", async () => {
  const f = fixture(), write = f.p.files.write.bind(f.p.files);
  try {
    await f.runtime.refresh();
    f.p.files.write = (name, value) => { if (name === "health.json") throw new Error("synthetic final write failure"); write(name, value); };
    await f.runtime.stop(); await f.runtime.stop();
    assert.equal(f.runtime.life.alive(), false); assert.equal(f.p.files.ownsConsumer(), false);
    f.p.files.write = write;
    const reopened = new PrivateFiles(f.p.root);
    try { const release = reopened.acquire(); release(); } finally { reopened.close(); }
  } finally { f.p.files.write = write; await f.close(); }
});