import test from "node:test";
import assert from "node:assert/strict";
import { TokenClient, type AuthConfig, type Config } from "../src/auth.ts";
import { SafeError, type Fetch } from "../src/http.ts";
import { fingerprint, newExchange, parseExchange, refreshBinding, validBearer, type RefreshCommit, type RefreshExchange } from "../src/refresh.ts";
import { config, deferred, identity, profile, response } from "./helpers.ts";

const canonical: Config = { ...config, origin: "https://concourse.krishnan.ca", issuer: "https://app.krishnan.ca", tokenEndpoint: "https://app.krishnan.ca/oauth/token", authorizationEndpoint: "https://app.krishnan.ca/oauth/authorize", auth: { kind: "oauth", redirectUri: "http://127.0.0.1:4555/callback" } };
const capability = () => ({ version: 1, header: "Idempotency-Key", key_format: "sf-string-uuid-v4", dispatch_header: "Concourse-Refresh-Dispatch", window_seconds: 86400, max_dispatches_per_exchange: 8, max_reissues: 3, max_conflict_retries: 4, mode: "replace_unconsumed_successor", successor_consumption: "refresh_token_rotation", late_request_behavior: "reject_without_family_revocation", scope: "concourse", resources: [canonical.origin, `${canonical.origin}/mcp`] });
const v2 = () => ({ version: 2, grant_type: "refresh_token", request_parameter: "concourse_refresh_exchange_id", window_seconds: 60, max_dispatches_per_exchange: 2, max_reissues_per_exchange: 1, mode: "replace_unconsumed_successor", late_request_behavior: "reject_without_family_revocation", scope: "concourse", resources: [canonical.origin, `${canonical.origin}/mcp`] });
const v3 = () => ({ ...v2(), version: 3, version_parameter: "concourse_refresh_exchange_version", max_dispatches_per_exchange: 4, max_reissues_per_exchange: 3, window_seconds: 86400, successor_consumption: "refresh_token_rotation" });
const metadata = () => ({ issuer: canonical.issuer, token_endpoint: canonical.tokenEndpoint, concourse_refresh_idempotency: capability() });
const old = (c = canonical) => ({ access: "old.access", refresh: "parent.refresh", expires: 1, resource: c.origin, clientId: c.oauthClientId, issuer: c.issuer });
const requestHeaders = new WeakMap<URLSearchParams, Headers>();
const headers = (form: URLSearchParams): Headers => { const h = requestHeaders.get(form); assert.ok(h, "synthetic request headers captured"); return h; };
function marker(form: URLSearchParams): string | null {
  const value = headers(form).get("Idempotency-Key");
  if (value === null) return null;
  assert.match(value, /^"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/);
  return JSON.parse(value) as string;
}
function dispatch(form: URLSearchParams): number {
  const value = headers(form).get("Concourse-Refresh-Dispatch");
  assert.match(value ?? "", /^[1-8]$/);
  return Number(value);
}
const receipt = (key: string, ordinal = 1, generation = 1) => ({ version: 1, key, dispatch: ordinal, generation, expires_at: 1_900_000_000 });
function issued(source: URLSearchParams | string | null, ordinal = source instanceof URLSearchParams && marker(source) ? dispatch(source) : 1, generation = 1) {
  const key = source instanceof URLSearchParams ? marker(source) : source;
  return { access_token: "new.access", refresh_token: "successor.refresh", token_type: "Bearer", expires_in: 3600, scope: "concourse", ...(key ? { concourse_refresh_idempotency: receipt(key, ordinal, generation) } : {}) };
}
function conflict(form: URLSearchParams): Response {
  return new Response(JSON.stringify({ type: "urn:ajent:oauth:refresh-idempotency-in-progress", title: "Refresh exchange is processing", status: 409, error: "concourse_refresh_in_progress", concourse_refresh_idempotency: { version: 1, key: marker(form), dispatch: dispatch(form) } }), { status: 409, headers: { "content-type": "application/problem+json", "cache-control": "no-store", "retry-after": "1" } });
}
type Stored = ReturnType<typeof old> & { refreshCommit?: RefreshCommit };
function fixture(c: AuthConfig = canonical) {
  const p = profile();
  p.files.acquire();
  const state = { wall: 1_000_000, alive: true };
  const forms: URLSearchParams[] = [], waits: number[] = []; let reads = 0, identities = 0;
  const hooks = {
    discover: async (): Promise<Response> => response(metadata()),
    post: async (form: URLSearchParams): Promise<Response> => response(issued(form)),
    identity: async (): Promise<Response> => response(identity),
    pause: async (milliseconds: number): Promise<void> => { assert.ok(milliseconds >= 1000); waits.push(milliseconds); },
  };
  const transport: Fetch = async (url, init) => {
    assert.equal(init?.redirect, new Headers(init?.headers).has("Idempotency-Key") ? "manual" : "error");
    const u = String(url);
    if (u === `${canonical.issuer}/.well-known/oauth-authorization-server`) {
      reads++; assert.equal(init?.method, "GET"); assert.equal(new Headers(init?.headers).get("authorization"), null);
      return hooks.discover();
    }
    if (u === c.tokenEndpoint) {
      assert.equal(init?.method, "POST");
      const f = new URLSearchParams(String(init?.body)); forms.push(f);
      requestHeaders.set(f, new Headers(init?.headers));
      assert.equal(f.get("resource"), c.origin); assert.equal(f.get("scope"), "concourse"); assert.equal(f.get("client_id"), c.oauthClientId);
      assert.equal([...f.keys()].some(k => k.startsWith("concourse_")), false, "no custom refresh form parameters");
      if (marker(f)) {
        const j = journal();
        assert.equal(f.get("grant_type"), "refresh_token");
        assert.equal(j.id, marker(f)); assert.equal(j.dispatches, dispatch(f)); assert.equal(j.ownerEpoch, p.files.consumerEpoch());
        assert.equal(j.phase, "dispatch-uncertain", "reservation must precede POST");
      } else assert.equal(headers(f).get("Concourse-Refresh-Dispatch"), null);
      return hooks.post(f);
    }
    assert.equal(u, `${c.origin}/api/identity`, "all calls must use the synthetic routes");
    identities++; assert.equal(new Headers(init?.headers).get("authorization"), "Bearer new.access");
    const code = p.files.read<{ phase: string }>("oauth-code-exchange.json");
    if (code) assert.ok(["dispatch-uncertain", "committing"].includes(code.phase));
    else assert.equal(journal().phase, "processing");
    assert.equal(p.files.read<Stored>("tokens.json")!.access, "old.access", "identity must precede credential commit");
    return hooks.identity();
  };
  let transportAssertion: Error | undefined;
  const checkedTransport: Fetch = async (...args) => {
    try { return await transport(...args); }
    catch (e) { if (e instanceof assert.AssertionError) transportAssertion = e; throw e; }
  };
  const guard = () => { if (!state.alive) throw new SafeError("SESSION_REPLACED"); };
  const client = () => new TokenClient(c, p.files, checkedTransport, () => state.wall, guard, ms => hooks.pause(ms));
  const journal = () => p.files.read<RefreshExchange>("oauth-exchange.json")!;
  const eligible = (): RefreshExchange => ({ ...newExchange(refreshBinding(canonical), old().refresh, p.files.consumerEpoch()), phase: "retry-eligible" });
  p.files.write("tokens.json", old(c as Config));
  // Transport wrappers must not disguise a failed fixture assertion as expected loss.
  const cleanup = () => { p.cleanup(); if (transportAssertion) throw transportAssertion; };
  return { ...p, cleanup, state, forms, waits, hooks, transport: checkedTransport, client, journal, eligible, reads: () => reads, identities: () => identities };
}
type Fixture = ReturnType<typeof fixture>;
async function signInFresh(f: Fixture) {
  const client = f.client(), original = f.files.read("oauth-exchange.json"), url = client.authorizationUrl({ fresh: true });
  assert.deepEqual(f.files.read("oauth-exchange.json"), original);
  f.hooks.post = async form => { assert.equal(form.get("grant_type"), "authorization_code"); assert.equal(marker(form), null); return response(issued(null)); };
  await client.completeAuthorization({ code: "fresh.code", state: new URL(url).searchParams.get("state")!, iss: canonical.issuer });
  assert.equal(f.files.read("oauth-exchange.json"), false);
  assert.equal(f.files.read("oauth-code-exchange.json"), false);
}

for (const lost of ["before issuance", "after issuance"]) test(`lost response ${lost}: the next call resumes the same marker and recovers`, async () => {
  const f = fixture(); let generation = 0;
  try {
    f.hooks.post = async form => {
      const j = f.journal(); assert.equal(j.phase, "dispatch-uncertain"); assert.equal(j.dispatches, f.forms.length);
      assert.equal(j.parentFingerprint, fingerprint(old().refresh)); assert.equal(JSON.stringify(j).includes(old().refresh), false);
      assert.match(j.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      if (f.forms.length === 1) { if (lost === "after issuance") generation++; throw new TypeError("synthetic lost token response"); }
      generation++; return response(issued(form, dispatch(form), generation));
    };
    const client = f.client();
    const errors = await Promise.allSettled([client.token(), client.token()]);
    for (const e of errors) { assert.equal(e.status, "rejected"); assert.match(String((e as PromiseRejectedResult).reason), /TRANSPORT_FAILED/); assert.equal(((e as PromiseRejectedResult).reason as SafeError).uncertain, false); }
    assert.equal(f.forms.length, 1); assert.equal(f.journal().phase, "retry-eligible"); assert.equal(f.journal().dispatches, 1);
    assert.equal(await f.client().token(), "new.access");
    assert.equal(f.forms.length, 2); assert.equal(f.reads(), 2); assert.equal(f.identities(), 1);
    assert.equal(f.forms[0].toString(), f.forms[1].toString());
    const comparable = (form: URLSearchParams) => { const h = new Headers(headers(form)); h.delete("Concourse-Refresh-Dispatch"); return [...h.entries()]; };
    assert.deepEqual(comparable(f.forms[0]), comparable(f.forms[1]), "all other headers remain identical");
    assert.deepEqual(f.forms.map(dispatch), [1, 2]);
    assert.equal(headers(f.forms[0]).get("Idempotency-Key"), `"${marker(f.forms[0])}"`);
    assert.equal(f.files.read("oauth-exchange.json"), false);
    const t = f.files.read<Stored>("tokens.json")!;
    assert.equal(t.refreshCommit!.generation, lost === "after issuance" ? 2 : 1);
    assert.equal(t.refreshCommit!.id, marker(f.forms[0]));
    assert.equal(t.refreshCommit!.successorFingerprint, fingerprint(t.refresh));
  } finally { f.cleanup(); }
});

test("long laptop sleep: the much later retry needs no client clock; the issuer accepts or refuses cleanly", async () => {
  for (const issuerAccepts of [true, false]) {
    const f = fixture();
    try {
      f.hooks.post = async () => { throw new TypeError("connection lost across sleep"); };
      await assert.rejects(f.client().token(), /TRANSPORT_FAILED/);
      f.state.wall += 8 * 60 * 60 * 1000; // Wall time is never consulted for the exchange.
      f.hooks.post = async form => {
        assert.equal(marker(form), marker(f.forms[0]));
        return issuerAccepts ? response(issued(form, dispatch(form), 2)) : response({ error: "invalid_grant" }, 400);
      };
      if (issuerAccepts) {
        assert.equal(await f.client().token(), "new.access"); assert.equal(f.files.read("oauth-exchange.json"), false);
      } else {
        await assert.rejects(f.client().token(), /OPERATOR_OAUTH_REQUIRED/);
        assert.equal(f.journal().phase, "refused"); assert.deepEqual(f.files.read("tokens.json"), old());
        await assert.rejects(f.client().token(), /OPERATOR_OAUTH_REQUIRED/);
        assert.equal(f.forms.length, 2);
        await signInFresh(f); assert.equal(f.forms.length, 3);
      }
    } finally { f.cleanup(); }
  }
});

for (const status of [408, 429, 500, 502, 503]) test(`HTTP ${status} is an explicit refusal: no automatic retry`, async () => {
  const f = fixture();
  try {
    f.hooks.post = async () => new Response("untrusted error", { status, headers: { "retry-after": "1" } });
    await assert.rejects(f.client().token(), (e: unknown) => e instanceof SafeError && e.code === `HTTP_REFUSED_${status}` && e.status === status);
    assert.equal(f.journal().phase, "locked");
    assert.equal(f.client().exchangeState(), "fenced");
    assert.deepEqual(f.files.read("tokens.json"), old());
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(f.forms.length, 1); assert.equal(f.reads(), 1); assert.deepEqual(f.waits, []);
  } finally { f.cleanup(); }
});

for (const status of [400, 401, 403]) test(`HTTP ${status} is a certain refusal: sign-in required, no further POST`, async () => {
  const f = fixture();
  try {
    f.hooks.post = async () => response({ error: "invalid_grant" }, status);
    await assert.rejects(f.client().token(), /OPERATOR_OAUTH_REQUIRED/);
    assert.equal(f.journal().phase, "refused"); assert.deepEqual(f.files.read("tokens.json"), old());
    await assert.rejects(f.client().token(), /OPERATOR_OAUTH_REQUIRED/);
    assert.equal(f.forms.length, 1); assert.equal(f.reads(), 1);
    assert.throws(() => f.client().authorizationUrl(), /OAUTH_EXCHANGE_UNCERTAIN/);
  } finally { f.cleanup(); }
});

for (const fail of [async () => response({}, 422), async () => response({}, 302)]) test("422 and redirects lock the exchange", async () => {
  const f = fixture();
  try {
    f.hooks.post = fail;
    await assert.rejects(f.client().token());
    assert.equal(f.journal().phase, "locked");
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.forms.length, 1); assert.equal(f.reads(), 1);
  } finally { f.cleanup(); }
});

test("eight lost dispatches exhaust the cap across re-instantiation; no ninth refresh POST", async () => {
  const f = fixture();
  try {
    f.hooks.post = async () => { throw new Error("synthetic loss"); };
    for (let n = 1; n <= 7; n++) { await assert.rejects(f.client().token(), /TRANSPORT_FAILED/); assert.equal(f.journal().dispatches, n); assert.equal(f.journal().phase, "retry-eligible"); }
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(f.journal().dispatches, 8); assert.equal(f.journal().phase, "locked");
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(f.forms.length, 8); assert.equal(f.reads(), 8);
    assert.equal(new Set(f.forms.map(marker)).size, 1);
    await signInFresh(f);
  } finally { f.cleanup(); }
});

test("a crash after the durable journal write counts that dispatch and resumes the same marker", async () => {
  const f = fixture(), write = f.files.write.bind(f.files);
  try {
    f.files.write = (name, value) => { write(name, value); if (name === "oauth-exchange.json" && (value as RefreshExchange)?.phase === "dispatch-uncertain") throw new Error("synthetic crash after journal"); };
    await assert.rejects(f.client().token(), /synthetic crash/);
    f.files.write = write;
    const j = f.journal(); assert.equal(f.forms.length, 0); assert.equal(j.dispatches, 1); assert.equal(j.phase, "dispatch-uncertain");
    f.hooks.post = async form => { assert.equal(marker(form), j.id); assert.equal(f.journal().dispatches, 2); return response(issued(j.id, 2)); };
    assert.equal(await f.client().token(), "new.access"); assert.equal(f.forms.length, 1);
  } finally { f.files.write = write; f.cleanup(); }
});

test("a crash after the eighth journal write stays fenced without discovery", async () => {
  const f = fixture();
  try {
    f.files.write("oauth-exchange.json", { ...f.eligible(), dispatches: 8, phase: "dispatch-uncertain" });
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.forms.length, 0); assert.equal(f.reads(), 0);
  } finally { f.cleanup(); }
});

for (const phase of ["processing", "locked"] as const) test(`restart keeps ${phase} fenced without dispatch or discovery`, async () => {
  const f = fixture();
  try {
    f.files.write("oauth-exchange.json", { ...f.eligible(), phase });
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(f.forms.length, 0); assert.equal(f.reads(), 0);
  } finally { f.cleanup(); }
});

const unsupported: [string, () => unknown][] = [
  ["absent", () => ({ issuer: canonical.issuer, token_endpoint: canonical.tokenEndpoint, grant_types_supported: ["refresh_token"] })],
  ["v2 only", () => ({ issuer: canonical.issuer, token_endpoint: canonical.tokenEndpoint, concourse_refresh_recovery: v2() })],
  ["v3 only", () => ({ issuer: canonical.issuer, token_endpoint: canonical.tokenEndpoint, concourse_refresh_recovery_v3: v3() })],
  ["new shape under the old key", () => ({ issuer: canonical.issuer, token_endpoint: canonical.tokenEndpoint, concourse_refresh_recovery: capability() })],
  ["new plus old v2 advertisement", () => ({ ...metadata(), concourse_refresh_recovery: v2() })],
  ["new plus old v3 advertisement", () => ({ ...metadata(), concourse_refresh_recovery_v3: v3() })],
  ["wrong discovery issuer", () => ({ ...metadata(), issuer: "https://wrong.invalid" })],
  ["wrong endpoint", () => ({ ...metadata(), token_endpoint: `${canonical.tokenEndpoint}/other` })],
  ["malformed", () => ({ ...metadata(), concourse_refresh_idempotency: [] })],
  ["extra property", () => ({ ...metadata(), concourse_refresh_idempotency: { ...capability(), unknown: true } })],
  ...Object.keys(capability()).map((key): [string, () => unknown] => [`missing ${key}`, () => { const v: Record<string, unknown> = capability(); delete v[key]; return { ...metadata(), concourse_refresh_idempotency: v }; }]),
  ...Object.keys(capability()).map((key): [string, () => unknown] => [`wrong ${key}`, () => ({ ...metadata(), concourse_refresh_idempotency: { ...capability(), [key]: key === "resources" ? [canonical.origin, "https://wrong.invalid/mcp"] : "wrong" } })]),
  ["extra resource", () => ({ ...metadata(), concourse_refresh_idempotency: { ...capability(), resources: [...capability().resources, "https://other.invalid"] } })],
  ["duplicate resource", () => ({ ...metadata(), concourse_refresh_idempotency: { ...capability(), resources: [canonical.origin, canonical.origin] } })],
];
for (const [name, value] of unsupported) test(`capability ${name}: NEW refresh has only one unmarked try; saved exchange never falls back`, async () => {
  for (const restart of [false, true]) {
    const f = fixture();
    try {
      const j = f.eligible();
      if (restart) f.files.write("oauth-exchange.json", j);
      f.hooks.discover = async () => response(value());
      f.hooks.post = async form => { assert.equal(marker(form), null); throw new Error("lost"); };
      await assert.rejects(f.client().token(), restart ? /OAUTH_EXCHANGE_UNCERTAIN/ : /TRANSPORT_FAILED/);
      assert.equal(f.forms.length, restart ? 0 : 1);
      assert.equal(f.reads(), 1);
      if (restart) assert.deepEqual(f.journal(), j);
      else {
        assert.equal(f.files.read("oauth-exchange.json"), true);
        await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
        assert.equal(f.forms.length, 1);
      }
    } finally { f.cleanup(); }
  }
});

test("v2-only metadata still refreshes successfully, unmarked", async () => {
  const f = fixture();
  try {
    f.hooks.discover = async () => response({ issuer: canonical.issuer, token_endpoint: canonical.tokenEndpoint, concourse_refresh_recovery: v2() });
    f.hooks.post = async form => { assert.equal(marker(form), null); return response(issued(null)); };
    assert.equal(await f.client().token(), "new.access"); assert.equal(f.files.read("oauth-exchange.json"), false);
    assert.equal(f.files.read<Stored>("tokens.json")!.refreshCommit, undefined);
  } finally { f.cleanup(); }
});

for (const discover of [async () => { throw new Error("offline"); }, async () => response({}, 503), async () => new Response("bad JSON")]) test("metadata read failure downgrades only NEW refresh to one unmarked try, never a resumed journal", async () => {
  for (const restart of [false, true]) {
    const f = fixture();
    try {
      if (restart) f.files.write("oauth-exchange.json", f.eligible());
      f.hooks.discover = discover; f.hooks.post = async form => { assert.equal(marker(form), null); throw new Error("lost"); };
      await assert.rejects(f.client().token(), restart ? /OAUTH_EXCHANGE_UNCERTAIN/ : /TRANSPORT_FAILED/);
      assert.equal(f.forms.length, restart ? 0 : 1);
      if (restart) assert.equal(f.journal().phase, "retry-eligible");
      else { assert.equal(f.files.read("oauth-exchange.json"), true); await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.forms.length, 1); }
    } finally { f.cleanup(); }
  }
});

test("capability removed before resume stays fenced instead of downgrading its marked exchange", async () => {
  const f = fixture();
  try {
    const j = f.eligible(); f.files.write("oauth-exchange.json", j);
    f.hooks.discover = async () => response({ issuer: canonical.issuer, token_endpoint: canonical.tokenEndpoint, concourse_refresh_recovery: v2() });
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.forms.length, 0);
    assert.deepEqual(f.journal(), j);
  } finally { f.cleanup(); }
});

for (const c of [{ ...canonical, issuer: "https://issuer.invalid", tokenEndpoint: "https://issuer.invalid/token", authorizationEndpoint: "https://issuer.invalid/authorize" }, { ...canonical, issuer: `${canonical.issuer}/` }, { ...canonical, origin: "https://other.invalid" }]) test(`noncanonical binding never discovers or marks (${c.issuer}, ${c.origin})`, async () => {
  const f = fixture(c);
  try {
    f.hooks.post = async form => { assert.equal(marker(form), null); throw new Error("lost"); };
    await assert.rejects(f.client().token(), /TRANSPORT_FAILED/); assert.equal(f.reads(), 0); assert.equal(f.forms.length, 1);
  } finally { f.cleanup(); }
});

test("AuthConfig-only onboarding stays legacy without metadata reads or retry", async () => {
  const { organization: _o, owner: _w, agent: _a, ...auth } = canonical;
  const f = fixture(auth);
  try {
    f.hooks.post = async form => { assert.equal(marker(form), null); throw new Error("lost"); };
    await assert.rejects(f.client().token(), /TRANSPORT_FAILED/); assert.equal(f.forms.length, 1); assert.equal(f.reads(), 0);
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.forms.length, 1);
  } finally { f.cleanup(); }
});

for (const fail of [async () => new Response("bad JSON"), async () => response({}), async (form: URLSearchParams) => response({ ...issued(form), refresh_token: "bad\nnewline" }), async (form: URLSearchParams) => response({ ...issued(form), refresh_token: "x".repeat(16_385) })]) test("a returned but unusable 2xx body stays processing and never retries", async () => {
  const f = fixture();
  try {
    f.hooks.post = fail; await assert.rejects(f.client().token()); assert.equal(f.forms.length, 1);
    assert.equal(f.journal().phase, "processing");
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.forms.length, 1);
  } finally { f.cleanup(); }
});

for (const bad of [undefined, "empty", { key: "wrong" }, { key: undefined }, { dispatch: undefined }, { dispatch: 0 }, { dispatch: 2 }, { dispatch: "1" }, { version: 2 }, { version: "1" }, { generation: 0 }, { generation: 2 }, { generation: 5 }, { generation: "1" }, { expires_at: undefined }, { expires_at: "1900000000" }, { expires_at: 1.5 }, { expires_at: 0 }, { extra: true }] as (Record<string, unknown> | "empty" | undefined)[]) test(`invalid receipt ${JSON.stringify(bad)} stays processing and never persists`, async () => {
  const f = fixture();
  try {
    f.hooks.post = async form => response({ ...issued(null), concourse_refresh_idempotency: bad === "empty" ? {} : bad ? { ...receipt(marker(form)!, dispatch(form)), ...bad } : undefined });
    await assert.rejects(f.client().token(), /INVALID_REFRESH_EXCHANGE_RESPONSE/);
    assert.equal(f.journal().phase, "processing"); assert.equal(f.forms.length, 1); assert.equal(f.identities(), 0);
    assert.deepEqual(f.files.read("tokens.json"), old());
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.forms.length, 1);
  } finally { f.cleanup(); }
});

test("receipt generation may equal, never exceed, the durable dispatch count", async () => {
  const f = fixture();
  try {
    f.files.write("oauth-exchange.json", { ...f.eligible(), dispatches: 2 });
    f.hooks.post = async form => response(issued(form, dispatch(form), 4));
    await assert.rejects(f.client().token(), /INVALID_REFRESH_EXCHANGE_RESPONSE/);
    f.files.write("tokens.json", old()); f.files.write("oauth-exchange.json", { ...f.eligible(), dispatches: 3 });
    f.hooks.post = async form => response(issued(form, dispatch(form), 4));
    assert.equal(await f.client().token(), "new.access"); assert.equal(f.files.read<Stored>("tokens.json")!.refreshCommit!.generation, 4);
  } finally { f.cleanup(); }
});

for (const mutate of [
  (j: RefreshExchange) => ({ ...j, parentFingerprint: fingerprint("other.refresh") }),
  (j: RefreshExchange) => ({ ...j, binding: { ...j.binding, clientId: "other" } }),
  (j: RefreshExchange) => ({ ...j, binding: { ...j.binding, tokenEndpoint: `${canonical.tokenEndpoint}/other` } }),
  (j: RefreshExchange) => ({ ...j, binding: { ...j.binding, issuer: "https://wrong.invalid" } }),
  (j: RefreshExchange) => ({ ...j, binding: { ...j.binding, resource: "https://wrong.invalid" } }),
  (j: RefreshExchange) => ({ ...j, binding: { ...j.binding, scope: "other" } }),
  (j: RefreshExchange) => ({ ...j, binding: { ...j.binding, agent: "other" } }),
  (j: RefreshExchange) => ({ ...j, version: 2 }),
  (j: RefreshExchange) => ({ ...j, version: 3 }),
  (j: RefreshExchange) => ({ ...j, dispatches: 8 }),
  (j: RefreshExchange) => ({ ...j, dispatches: 9 }),
  (j: RefreshExchange) => ({ ...j, conflictRetries: 5 }),
  (j: RefreshExchange) => ({ ...j, conflictRetries: 1 }),
  (j: RefreshExchange) => ({ ...j, ownerEpoch: "bad" }),
  (j: RefreshExchange) => ({ ...j, dispatches: 0 }),
  (j: RefreshExchange) => ({ ...j, phase: "other" }),
  (j: RefreshExchange) => ({ ...j, extra: true }),
  (j: RefreshExchange) => { const { dispatches: _d, ...rest } = j; return { ...rest, attempts: 1, bootId: "00000000-0000-4000-8000-000000000001" }; },
  (_j: RefreshExchange) => true,
  (_j: RefreshExchange) => null,
  (_j: RefreshExchange) => 0,
]) test("mismatched/legacy/malformed/exhausted fences never get upgraded to marked requests", async () => {
  const f = fixture();
  try {
    f.files.write("oauth-exchange.json", mutate(f.eligible()));
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(f.forms.length, 0); assert.equal(f.reads(), 0);
  } finally { f.cleanup(); }
});

for (const point of ["initial journal", "retry-eligible", "processing", "committing", "tokens", "clear"] as const) test(`storage failure at ${point} poisons only that client and preserves the durable fence`, async () => {
  const f = fixture(), write = f.files.write.bind(f.files), client = f.client();
  try {
    f.hooks.post = async form => {
      if (point === "retry-eligible" && f.forms.length === 1) throw new Error("lost");
      return response(issued(form));
    };
    f.files.write = (name, value) => {
      const j = value as RefreshExchange;
      if ((point === "initial journal" && name === "oauth-exchange.json" && j?.phase === "dispatch-uncertain") ||
          (point === "retry-eligible" && name === "oauth-exchange.json" && j?.phase === "retry-eligible") ||
          (point === "processing" && name === "oauth-exchange.json" && j?.phase === "processing") ||
          (point === "committing" && name === "oauth-exchange.json" && j?.phase === "committing") ||
          (point === "tokens" && name === "tokens.json") ||
          (point === "clear" && name === "oauth-exchange.json" && value === false)) throw new Error(`synthetic disk ${point}`);
      write(name, value);
    };
    await assert.rejects(client.token(), /synthetic disk/);
    const calls = point === "initial journal" ? 0 : 1;
    assert.equal(f.forms.length, calls);
    f.files.write = write;
    assert.throws(() => client.token(), /OAUTH_STORAGE_UNCERTAIN/, "same client stays poisoned after disk recovers");
    assert.equal(f.forms.length, calls);
    if (point === "processing" || point === "retry-eligible") assert.equal(f.journal().phase, "dispatch-uncertain");
    if (point === "committing") assert.equal(f.journal().phase, "processing");
    if (point === "tokens") {
      assert.equal(f.journal().phase, "committing");
      assert.ok(f.journal().commit);
      assert.deepEqual(f.files.read("tokens.json"), old());
    }
    const restarted = f.client();
    if (point === "tokens" || point === "committing") {
      await assert.rejects(restarted.token(), /OAUTH_EXCHANGE_UNCERTAIN/);
      assert.equal(f.forms.length, calls);
    } else {
      assert.equal(await restarted.token(), "new.access");
      assert.equal(f.forms.length, point === "clear" ? calls : calls + 1);
      if (point === "retry-eligible" || point === "processing") assert.equal(marker(f.forms[0]), marker(f.forms[1]));
    }
  } finally { f.files.write = write; f.cleanup(); }
});

for (const mismatch of ["organization", "owner", "handle", "oauth_client_id", "release_line"]) test(`candidate identity ${mismatch} mismatch keeps old credentials and processing fence`, async () => {
  const f = fixture();
  try {
    f.hooks.identity = async () => response({ ...identity, [mismatch]: "other" });
    await assert.rejects(f.client().token(), /V3_IDENTITY_REFUSED/);
    assert.deepEqual(f.files.read("tokens.json"), old()); assert.equal(f.journal().phase, "processing");
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.forms.length, 1);
  } finally { f.cleanup(); }
});

test("identity transport loss never retries a token POST", async () => {
  const f = fixture();
  try {
    f.hooks.identity = async () => { throw new Error("lost identity"); };
    await assert.rejects(f.client().token(), /TRANSPORT_FAILED/); assert.equal(f.forms.length, 1);
    assert.deepEqual(f.files.read("tokens.json"), old()); assert.equal(f.journal().phase, "processing");
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.forms.length, 1);
  } finally { f.cleanup(); }
});

for (const stage of ["metadata", "post", "identity", "journal write", "token write"] as const) test(`lifecycle guard at ${stage} cannot dispatch/save/clear afterwards`, async () => {
  const f = fixture(), write = f.files.write.bind(f.files);
  try {
    if (stage === "metadata") f.hooks.discover = async () => { f.state.alive = false; return response(metadata()); };
    if (stage === "post") f.hooks.post = async form => { f.state.alive = false; return response(issued(form)); };
    if (stage === "identity") f.hooks.identity = async () => { f.state.alive = false; return response(identity); };
    f.files.write = (name, value) => {
      write(name, value);
      if ((stage === "journal write" && name === "oauth-exchange.json") || (stage === "token write" && name === "tokens.json")) f.state.alive = false;
    };
    await assert.rejects(f.client().token(), /SESSION_REPLACED/);
    assert.equal(f.forms.length, ["metadata", "journal write"].includes(stage) ? 0 : 1);
    if (stage !== "token write") assert.deepEqual(f.files.read("tokens.json"), old());
    else assert.equal(f.journal().phase, "committing");
  } finally { f.files.write = write; f.cleanup(); }
});

test("lost-response guard failure is not reclassified as retry-eligible", async () => {
  const f = fixture();
  try {
    f.hooks.post = async () => { f.state.alive = false; throw new Error("lost"); };
    await assert.rejects(f.client().token(), /SESSION_REPLACED/);
    assert.equal(f.journal().phase, "dispatch-uncertain");
  } finally { f.cleanup(); }
});

test("ownership error from discovery is not silently downgraded", async () => {
  const f = fixture();
  try {
    f.hooks.discover = async () => { throw new SafeError("SESSION_REPLACED"); };
    await assert.rejects(f.client().token(), /SESSION_REPLACED/); assert.equal(f.forms.length, 0);
  } finally { f.cleanup(); }
});

test("fresh authorization cannot overlap capability discovery", async () => {
  const f = fixture(), entered = deferred<void>(), gate = deferred<Response>();
  try {
    f.hooks.discover = async () => { entered.resolve(); return gate.promise; };
    const operation = f.client(); const pending = operation.token(); await entered.promise;
    assert.throws(() => operation.authorizationUrl({ fresh: true }), /OAUTH_EXCHANGE_IN_PROGRESS/);
    gate.resolve(response(metadata())); await pending;
  } finally { f.cleanup(); }
});

async function interruptedClear(f: Fixture): Promise<{ journal: RefreshExchange; tokens: Stored }> {
  const write = f.files.write.bind(f.files);
  try {
    f.files.write = (name, value) => { if (name === "oauth-exchange.json" && value === false) throw new Error("synthetic clear failure"); write(name, value); };
    await assert.rejects(f.client().token(), /synthetic clear failure/);
    return { journal: f.journal(), tokens: f.files.read<Stored>("tokens.json")! };
  } finally { f.files.write = write; }
}

test("restart reconciles an exact committed receipt without any request when access is still valid", async () => {
  const f = fixture();
  try {
    await interruptedClear(f); assert.equal(f.journal().phase, "committing");
    assert.equal(await f.client().token(), "new.access");
    assert.equal(f.files.read("oauth-exchange.json"), false);
    assert.equal(f.forms.length, 1); assert.equal(f.reads(), 1); assert.equal(f.identities(), 1);
  } finally { f.cleanup(); }
});

test("exact commit receipt reconciles even after successor expiry; only a NEW successor exchange may rotate", async () => {
  const f = fixture();
  try {
    const saved = await interruptedClear(f);
    f.state.wall += 3_600_001;
    f.hooks.post = async form => {
      assert.equal(form.get("refresh_token"), saved.tokens.refresh);
      assert.notEqual(marker(form), saved.journal.id);
      assert.equal(f.journal().parentFingerprint, fingerprint(saved.tokens.refresh));
      throw new Error("new exchange intentionally lost");
    };
    await assert.rejects(f.client().token(), /TRANSPORT_FAILED/);
    assert.equal(f.forms.length, 2); assert.equal(f.forms[1].get("refresh_token"), "successor.refresh");
  } finally { f.cleanup(); }
});

for (const change of ["no receipt", "id", "parent", "generation", "version", "binding", "access", "refresh", "expires", "extra"]) test(`commit reconciliation rejects ${change}; different credentials are not proof`, async () => {
  const f = fixture();
  try {
    const { tokens } = await interruptedClear(f);
    if (change === "no receipt") delete tokens.refreshCommit;
    if (change === "id") tokens.refreshCommit!.id = "A".repeat(43);
    if (change === "parent") tokens.refreshCommit!.parentFingerprint = fingerprint("other");
    if (change === "generation") tokens.refreshCommit!.generation = 2;
    if (change === "version") Object.assign(tokens.refreshCommit!, { version: 2 });
    if (change === "binding") tokens.refreshCommit!.binding.agent = "other";
    if (change === "access") tokens.access = "different.access";
    if (change === "refresh") tokens.refresh = "different.refresh";
    if (change === "expires") tokens.expires++;
    if (change === "extra") Object.assign(tokens.refreshCommit!, { extra: true });
    f.files.write("tokens.json", tokens); f.state.wall += 3_600_001;
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(f.forms.length, 1); assert.equal(f.journal().phase, "committing");
  } finally { f.cleanup(); }
});

test("fresh code preserves the original refresh fence until success and never discovers, marks, or retries", async () => {
  const f = fixture();
  try {
    const original = { ...f.eligible(), phase: "processing" };
    f.files.write("oauth-exchange.json", original);
    f.hooks.post = async form => { assert.equal(form.get("grant_type"), "authorization_code"); assert.equal(marker(form), null); throw new Error("lost code response"); };
    const client = f.client(), url = client.authorizationUrl({ fresh: true });
    const callback = { code: "synthetic.code", state: new URL(url).searchParams.get("state")!, iss: canonical.issuer };
    await assert.rejects(client.completeAuthorization(callback), /TRANSPORT_FAILED/);
    await assert.rejects(client.completeAuthorization(callback), /OAUTH_CALLBACK_REFUSED/);
    assert.equal(f.forms.length, 1); assert.equal(f.reads(), 0); assert.deepEqual(f.files.read("oauth-exchange.json"), original);
    assert.equal(f.files.read<{ phase: string }>("oauth-code-exchange.json")!.phase, "dispatch-uncertain");
    await signInFresh(f); assert.equal(f.forms.length, 2); assert.equal(f.reads(), 0);
  } finally { f.cleanup(); }
});

test("explicit fresh PKCE replaces refused, locked and schema-malformed journals without retrying refresh", async () => {
  for (const fence of [null, 0, [], {}, { version: 1 }, { version: 2, phase: "retry-eligible", attempts: 2 }, { version: 3, phase: "retry-eligible", dispatches: 2 }, "refused", "locked"]) {
    const f = fixture();
    try {
      f.files.write("oauth-exchange.json", typeof fence === "string" ? { ...f.eligible(), phase: fence } : fence);
      await assert.rejects(f.client().token(), fence === "refused" ? /OPERATOR_OAUTH_REQUIRED/ : /OAUTH_EXCHANGE_UNCERTAIN/);
      const client = f.client(), url = client.authorizationUrl({ fresh: true });
      f.hooks.post = async form => { assert.equal(form.get("grant_type"), "authorization_code"); assert.equal(marker(form), null); return response(issued(null)); };
      let accepted = false;
      await client.completeAuthorization({ code: "fresh.code", state: new URL(url).searchParams.get("state")!, iss: canonical.issuer }, async () => { accepted = true; assert.deepEqual(f.files.read("tokens.json"), old()); });
      assert.equal(accepted, true); assert.equal(f.forms.length, 1); assert.equal(f.reads(), 0);
      assert.equal(f.files.read("oauth-exchange.json"), false);
    } finally { f.cleanup(); }
  }
});

test("valid cached access remains usable beside a legacy or unresolved structured fence", async () => {
  const f = fixture();
  try {
    for (const fence of [true, { ...f.eligible(), phase: "locked" }]) {
      f.files.write("tokens.json", { ...old(), expires: f.state.wall + 90_000 }); f.files.write("oauth-exchange.json", fence);
      assert.equal(await f.client().token(), "old.access"); assert.equal(f.forms.length, 0); assert.equal(f.reads(), 0);
      f.files.write("tokens.json", old());
      await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    }
  } finally { f.cleanup(); }
});

test("marked recovery syntax requires absolute end-of-input, not a trailing newline", () => {
  const f = fixture();
  try {
    assert.equal(validBearer("synthetic.token\n"), false);
    assert.equal(validBearer("synthetic.token\r\n"), false);
    assert.equal(validBearer("synthetic.token"), true);
    const j = f.eligible(), binding = refreshBinding(canonical);
    assert.ok(parseExchange(j, binding));
    for (const key of ["id", "parentFingerprint"] as const) assert.equal(parseExchange({ ...j, [key]: `${j[key]}\n` }, binding), undefined);
  } finally { f.cleanup(); }
});

test("opaque refresh tokens retain fresh PKCE and legacy refresh compatibility", async () => {
  const c = { ...canonical, issuer: "https://issuer.invalid", tokenEndpoint: "https://issuer.invalid/token", authorizationEndpoint: "https://issuer.invalid/authorize" };
  const f = fixture(c), opaque = "opaque:refresh! with space";
  try {
    const client = f.client(), url = client.authorizationUrl({ fresh: true });
    f.hooks.post = async form => { assert.equal(marker(form), null); return response({ ...issued(null), refresh_token: opaque }); };
    await client.completeAuthorization({ code: "fresh.code", state: new URL(url).searchParams.get("state")!, iss: c.issuer });
    assert.equal(f.files.read<Stored>("tokens.json")!.refresh, opaque);
    f.files.write("tokens.json", { ...old(c), refresh: opaque });
    assert.equal(await f.client().token(), "new.access");
    assert.equal(f.forms[1].get("refresh_token"), opaque);
    assert.equal(f.files.read("oauth-exchange.json"), false);
    assert.equal(f.forms.length, 2); assert.equal(f.reads(), 0);
  } finally { f.cleanup(); }
});

test("marked exchanges and commit reconciliation preserve opaque parent and successor tokens", async () => {
  const f = fixture(), opaque = "opaque:refresh! with space", write = f.files.write.bind(f.files);
  try {
    f.files.write("tokens.json", { ...old(), refresh: opaque });
    f.hooks.post = async form => response({ ...issued(form), refresh_token: opaque + " next" });
    f.files.write = (name, value) => { if (name === "oauth-exchange.json" && value === false) throw new Error("synthetic fence-clear failure"); write(name, value); };
    await assert.rejects(f.client().token(), /synthetic fence-clear failure/);
    f.files.write = write;
    assert.equal(await f.client().token(), "new.access");
    assert.equal(f.files.read("oauth-exchange.json"), false); assert.equal(f.forms.length, 1);
    assert.equal(f.forms[0].get("refresh_token"), opaque);
    assert.equal(f.files.read<Stored>("tokens.json")!.refresh, opaque + " next");
  } finally { f.files.write = write; f.cleanup(); }
});

test("exchangeState mirrors acquire(): only a valid matching journal with remaining budgets is resumable", () => {
  const f = fixture(), state = (v: unknown) => { f.files.write("oauth-exchange.json", v); return f.client().exchangeState(); };
  try {
    assert.equal(state(false), "clear");
    assert.equal(state(f.eligible()), "resumable");
    assert.equal(state({ ...f.eligible(), phase: "dispatch-uncertain" }), "resumable");
    assert.equal(state({ ...f.eligible(), phase: "dispatch-uncertain", dispatches: 7 }), "resumable");
    assert.equal(state({ ...f.eligible(), phase: "dispatch-uncertain", dispatches: 8 }), "fenced", "crash after eighth reservation");
    assert.equal(state({ ...f.eligible(), phase: "conflict", dispatches: 4, conflictRetries: 3 }), "resumable");
    assert.equal(state({ ...f.eligible(), phase: "conflict", dispatches: 5, conflictRetries: 4 }), "fenced", "conflict budget exhausted");
    assert.equal(state({ ...f.eligible(), phase: "retry-eligible", dispatches: 6, conflictRetries: 4 }), "resumable", "transport loss does not consume another conflict retry");
    assert.equal(state({ ...f.eligible(), parentFingerprint: fingerprint("other.refresh") }), "fenced");
    for (const version of [2, 3]) assert.equal(state({ ...f.eligible(), version }), "fenced", "legacy journals never migrate");
    assert.equal(state(true), "fenced");
    assert.equal(state({ ...f.eligible(), phase: "locked" }), "fenced");
    assert.equal(state({ ...f.eligible(), phase: "refused" }), "refused");
  } finally { f.cleanup(); }
});

test("five validated conflicts exhaust the lifetime conflict budget with three total slots unused", async () => {
  const f = fixture();
  try {
    f.hooks.post = async form => conflict(form);
    for (let ordinal = 1; ordinal <= 5; ordinal++) {
      await assert.rejects(f.client().token(), ordinal < 5 ? /REFRESH_IN_PROGRESS/ : /OAUTH_EXCHANGE_UNCERTAIN/);
      assert.equal(f.forms.length, ordinal, "one POST per token call");
      assert.equal(f.journal().dispatches, ordinal);
      assert.equal(f.journal().conflictRetries, ordinal - 1, "count the next reservation, not the response");
      assert.equal(f.journal().phase, ordinal < 5 ? "conflict" : "locked");
      assert.equal(f.waits.length, ordinal - 1);
      assert.deepEqual(f.files.read("tokens.json"), old());
    }
    const exhausted = f.journal();
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.deepEqual(f.journal(), exhausted); assert.equal(f.forms.length, 5); assert.equal(f.reads(), 5);
    assert.equal(new Set(f.forms.map(marker)).size, 1);
    assert.deepEqual(f.forms.map(dispatch), [1, 2, 3, 4, 5]);
    assert.ok(f.waits.every(ms => ms >= 1000));
  } finally { f.cleanup(); }
});

test("transport losses and conflicts retain independent counters across client restart and long sleep", async () => {
  const f = fixture();
  try {
    // Each call constructs a new TokenClient over the same synthetic owner lock.
    const outcomes = ["lost", "conflict", "lost", "conflict", "conflict", "lost", "conflict", "success"];
    const conflicts = [0, 0, 1, 1, 2, 3, 3, 4];
    const waitCounts = [0, 0, 1, 1, 2, 3, 3, 4];
    let finalJournal: RefreshExchange | undefined;
    f.hooks.post = async form => {
      const i = f.forms.length - 1;
      assert.equal(f.journal().conflictRetries, conflicts[i]);
      assert.equal(f.journal().dispatches, i + 1);
      if (outcomes[i] === "lost") throw new Error("synthetic transport loss");
      if (outcomes[i] === "conflict") return conflict(form);
      finalJournal = f.journal();
      return response(issued(form, dispatch(form), 2));
    };
    for (let i = 0; i < outcomes.length; i++) {
      if (outcomes[i] === "success") assert.equal(await f.client().token(), "new.access");
      else await assert.rejects(f.client().token(), outcomes[i] === "lost" ? /TRANSPORT_FAILED/ : /REFRESH_IN_PROGRESS/);
      assert.equal(f.forms.length, i + 1); assert.equal(f.waits.length, waitCounts[i]);
      if (i < 7) {
        assert.equal(f.journal().conflictRetries, conflicts[i]);
        assert.equal(f.journal().phase, outcomes[i] === "lost" ? "retry-eligible" : "conflict");
      }
      f.state.wall += 8 * 60 * 60 * 1000;
    }
    assert.equal(finalJournal!.dispatches, 8); assert.equal(finalJournal!.conflictRetries, 4);
    const commit = f.files.read<Stored>("tokens.json")!.refreshCommit!;
    assert.equal(commit.dispatch, 8); assert.equal(commit.generation, 2, "receipt generation is not the request ordinal");
    assert.equal(f.files.read("oauth-exchange.json"), false);
    assert.equal(new Set(f.forms.map(marker)).size, 1);
    assert.equal(new Set(f.forms.map(form => form.toString())).size, 1);
    const withoutOrdinal = f.forms.map(form => { const h = new Headers(headers(form)); h.delete("Concourse-Refresh-Dispatch"); return [...h.entries()]; });
    for (const h of withoutOrdinal) assert.deepEqual(h, withoutOrdinal[0]);
  } finally { f.cleanup(); }
});

test("crash after a conflict-triggered reservation refunds neither ordinal nor conflict counter", async () => {
  const f = fixture(), write = f.files.write.bind(f.files), client = f.client();
  try {
    f.hooks.post = async form => conflict(form);
    await assert.rejects(client.token(), /REFRESH_IN_PROGRESS/);
    const key = f.journal().id;
    f.files.write = (name, value) => {
      write(name, value);
      if (name === "oauth-exchange.json" && (value as RefreshExchange)?.phase === "dispatch-uncertain") throw new Error("crash after conflict reservation");
    };
    await assert.rejects(client.token(), /crash after conflict reservation/);
    assert.equal(f.forms.length, 1); assert.equal(f.journal().dispatches, 2); assert.equal(f.journal().conflictRetries, 1);
    f.files.write = write;
    assert.throws(() => client.token(), /OAUTH_STORAGE_UNCERTAIN/);
    f.hooks.post = async form => response(issued(form));
    assert.equal(await f.client().token(), "new.access");
    assert.deepEqual(f.forms.map(dispatch), [1, 3]); assert.equal(marker(f.forms[1]), key);
    assert.equal(f.waits.length, 1, "do not count an already-reserved conflict twice");
    assert.equal(f.files.read<Stored>("tokens.json")!.refreshCommit!.dispatch, 3);
  } finally { f.files.write = write; f.cleanup(); }
});

const invalidConflicts: [string, (r: Response) => Promise<Response>][] = [
  ["generic 409", async () => response({ error: "conflict" }, 409)],
  ["JSON media type", async r => { r.headers.set("content-type", "application/json"); return r; }],
  ["missing no-store", async r => { r.headers.delete("cache-control"); return r; }],
  ["missing Retry-After", async r => { r.headers.delete("retry-after"); return r; }],
  ["different Retry-After", async r => { r.headers.set("retry-after", "2"); return r; }],
  ["malformed body", async r => new Response("{", { status: 409, headers: r.headers })],
  ...["type", "error", "status", "title", "version", "key", "dispatch", "tokens", "generation", "expiry"].map((field): [string, (r: Response) => Promise<Response>] => [field, async r => {
    const b = await r.json();
    if (field === "type") b.type = "urn:unknown";
    if (field === "error") b.error = "invalid_grant";
    if (field === "status") b.status = 400;
    if (field === "title") delete b.title;
    if (field === "version") b.concourse_refresh_idempotency.version = 4;
    if (field === "key") b.concourse_refresh_idempotency.key = "00000000-0000-4000-8000-000000000001";
    if (field === "dispatch") b.concourse_refresh_idempotency.dispatch = 2;
    if (field === "tokens") b.access_token = "forbidden.access";
    if (field === "generation") b.concourse_refresh_idempotency.generation = 1;
    if (field === "expiry") b.concourse_refresh_idempotency.expires_at = 1_900_000_000;
    return new Response(JSON.stringify(b), { status: 409, headers: r.headers });
  }]),
];
for (const [name, mutate] of invalidConflicts) test(`invalid 409 ${name} locks rather than retrying`, async () => {
  const f = fixture();
  try {
    f.hooks.post = async form => mutate(conflict(form));
    await assert.rejects(f.client().token(), /INVALID_REFRESH_CONFLICT/);
    assert.equal(f.journal().phase, "locked"); assert.equal(f.journal().conflictRetries, 0);
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(f.forms.length, 1); assert.deepEqual(f.waits, []); assert.deepEqual(f.files.read("tokens.json"), old());
  } finally { f.cleanup(); }
});

test("validated conflict title is human text; a resumed request waits before POST", async () => {
  const f = fixture();
  try {
    f.hooks.post = async form => {
      if (f.forms.length > 1) { assert.deepEqual(f.waits, [1000]); return response(issued(form)); }
      const r = conflict(form), b = await r.json(); b.title = "Localized human title";
      return new Response(JSON.stringify(b), { status: 409, headers: r.headers });
    };
    await assert.rejects(f.client().token(), /REFRESH_IN_PROGRESS/);
    assert.deepEqual(f.waits, []);
    assert.equal(await f.client().token(), "new.access");
    assert.equal(f.files.read<Stored>("tokens.json")!.refreshCommit!.dispatch, 2);
    assert.equal(f.files.read<Stored>("tokens.json")!.refreshCommit!.generation, 1);
  } finally { f.cleanup(); }
});

for (const corruption of ["processing", "missing commit", "different commit", "identity"]) test(`token receipt alone cannot settle a journal with ${corruption}`, async () => {
  const f = fixture();
  try {
    const { journal } = await interruptedClear(f);
    if (corruption === "processing") { journal.phase = "processing"; delete journal.commit; }
    if (corruption === "missing commit") delete journal.commit;
    if (corruption === "different commit") journal.commit!.windowExpires++;
    if (corruption === "identity") journal.commit!.identity.agent_id++;
    f.files.write("oauth-exchange.json", journal);
    assert.equal(f.client().exchangeState(), "fenced", "valid token receipt must match the journal's exact expected commit");
    f.state.wall += 3_600_001;
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.deepEqual(f.journal(), journal); assert.equal(f.forms.length, 1);
  } finally { f.cleanup(); }
});

for (const version of [2, 3]) test(`a complete legacy v${version} journal stays fenced and is never migrated`, async () => {
  const f = fixture();
  try {
    const { ownerEpoch: _owner, conflictRetries: _conflicts, dispatches: _dispatches, ...base } = f.eligible();
    const legacy = { ...base, version, id: "A".repeat(43), ...(version === 2 ? { attempts: 1, bootId: "00000000-0000-4000-8000-000000000001" } : { dispatches: 1 }) };
    f.files.write("oauth-exchange.json", legacy);
    assert.equal(f.client().exchangeState(), "fenced");
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.deepEqual(f.files.read("oauth-exchange.json"), legacy);
    assert.equal(f.forms.length, 0); assert.equal(f.reads(), 0);
  } finally { f.cleanup(); }
});

for (const status of [200, 409]) test(`a broken HTTP ${status} response body never becomes a transport-loss retry`, async () => {
  const f = fixture();
  try {
    f.hooks.post = async form => new Response(new ReadableStream({ start(controller) { controller.error(new Error("synthetic truncated response")); } }), { status, headers: status === 409 ? conflict(form).headers : { "content-type": "application/json" } });
    await assert.rejects(f.client().token(), status === 409 ? /INVALID_REFRESH_CONFLICT/ : /INVALID_REFRESH_RESPONSE/);
    assert.equal(f.journal().phase, "locked");
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(f.forms.length, 1); assert.deepEqual(f.waits, []);
    assert.deepEqual(f.files.read("tokens.json"), old());
  } finally { f.cleanup(); }
});
