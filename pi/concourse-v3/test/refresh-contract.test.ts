import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/auth.ts";
import { SafeError, type Fetch } from "../src/http.ts";
import type { Identity } from "../src/types.ts";
import {
  MAX_CONFLICT_RETRIES, MAX_DISPATCHES, committed, commitReceipt, fingerprint,
  markRequest, newExchange, parseExchange, refreshBinding, reserveDispatch,
  responseReceipt, resumable, sameExchange, supportsRecovery, validBearer,
  validatedConflict, validRefresh, type RecoveryCapability, type RefreshExchange,
} from "../src/refresh.ts";

// All endpoints, tokens and identities below are synthetic; Fetch never leaves memory.
const config: Config = {
  version: 3, issuer: "https://app.krishnan.ca", tokenEndpoint: "https://app.krishnan.ca/oauth/token",
  origin: "https://concourse.krishnan.ca", organization: "test-org", owner: "owner", agent: "recipient",
  oauthClientId: "synthetic-client", auth: { kind: "oauth", redirectUri: "http://127.0.0.1:4555/callback" },
};
const epoch = "123e4567-e89b-42d3-a456-426614174000";
const nextEpoch = "223e4567-e89b-42d3-b456-426614174000";
const binding = refreshBinding(config);
const identity: Identity = { release_line: 3, organization: config.organization, owner: config.owner, handle: config.agent, oauth_client_id: config.oauthClientId, agent_id: 7, network_agent: "concourse/network-synthetic" };
const cap: RecoveryCapability = { header: "Idempotency-Key", dispatch_header: "Concourse-Refresh-Dispatch" };
const journal = (): RefreshExchange => newExchange(binding, "opaque:parent! with space", epoch);
const jsonResponse = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const capability = () => ({
  version: 1, header: "Idempotency-Key", key_format: "sf-string-uuid-v4", dispatch_header: "Concourse-Refresh-Dispatch",
  window_seconds: 86400, max_dispatches_per_exchange: 8, max_reissues: 3, max_conflict_retries: 4,
  mode: "replace_unconsumed_successor", successor_consumption: "refresh_token_rotation",
  late_request_behavior: "reject_without_family_revocation", scope: "concourse",
  resources: ["https://concourse.krishnan.ca", "https://concourse.krishnan.ca/mcp"],
});
const metadata = () => ({ issuer: config.issuer, token_endpoint: config.tokenEndpoint, concourse_refresh_idempotency: capability() });
const discover = (body: unknown, c = config) => supportsRecovery(c, (async () => jsonResponse(body)) as Fetch, () => {});
const wire = (j: RefreshExchange) => ({ version: 1 as const, key: j.id, dispatch: j.dispatches, generation: 1 as const, expires_at: 1_900_000_000 });
const readReceipt = (j: RefreshExchange, value: unknown = wire(j)) => responseReceipt({ concourse_refresh_idempotency: value }, j);
const tokens = () => ({ access: "synthetic.access", refresh: "opaque:successor! with space", expires: 1 });
function committing() {
  const j: RefreshExchange = { ...journal(), dispatches: 3, phase: "processing" };
  const t = tokens();
  const receipt = commitReceipt(j, readReceipt(j), identity, t.access, t.refresh, t.expires);
  return { j: { ...j, phase: "committing", commit: structuredClone(receipt) } as RefreshExchange, receipt, t };
}
const problem = (j: RefreshExchange) => ({ type: "urn:ajent:oauth:refresh-idempotency-in-progress", title: "Refresh exchange is processing", status: 409, error: "concourse_refresh_in_progress", concourse_refresh_idempotency: { version: 1, key: j.id, dispatch: j.dispatches } });
const conflictHeaders = () => ({ "content-type": "application/problem+json", "cache-control": "no-store", "retry-after": "1" });
const conflict = (j: RefreshExchange, body: unknown = problem(j), headers: HeadersInit = conflictHeaders(), status = 409) => new Response(JSON.stringify(body), { status, headers });
function safeCode(code: string, status?: number) {
  return (e: unknown) => {
    assert.ok(e instanceof SafeError);
    assert.equal(e.code, code); assert.equal(e.message, code); assert.equal(e.status, status);
    assert.deepEqual(e.details, {}); assert.equal(e.uncertain, false);
    return true;
  };
}
function reorder(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  return Object.fromEntries(Object.entries(v).reverse().map(([k, value]) => [k, reorder(value)]));
}

test("discovery accepts only the frozen header capability and canonical destinations", async () => {
  assert.deepEqual(await discover(metadata()), cap);
  assert.deepEqual(await discover(metadata(), { ...config, origin: `${config.origin}/mcp` }), cap);
  const reordered = metadata(); reordered.concourse_refresh_idempotency.resources.reverse();
  assert.deepEqual(await discover(reordered), cap, "resources are an exact set, not an ordering promise");
  for (const resource of [config.origin, `${config.origin}/mcp`]) assert.ok(capability().resources.includes(resource));
  for (const key of ["issuer", "token_endpoint"] as const) {
    for (const bad of [undefined, `${metadata()[key]}/`, "https://other.invalid/oauth/token", `${metadata()[key]}?extra=1`]) assert.equal(await discover({ ...metadata(), [key]: bad }), undefined);
  }
  let calls = 0;
  const fetchImpl = (async () => { calls++; return jsonResponse(metadata()); }) as Fetch;
  for (const changed of [{ issuer: `${config.issuer}/` }, { tokenEndpoint: `${config.tokenEndpoint}/` }, { tokenEndpoint: `${config.tokenEndpoint}?extra=1` }, { origin: `${config.origin}/` }, { origin: "https://other.invalid" }]) {
    assert.equal(await supportsRecovery({ ...config, ...changed }, fetchImpl, () => {}), undefined);
  }
  assert.equal(calls, 0);
});

test("every capability field is required and exact; legacy and mixed advertisements fail closed", async () => {
  for (const [key, value] of Object.entries(capability())) {
    const missing: Record<string, unknown> = capability(); delete missing[key];
    assert.equal(await discover({ ...metadata(), concourse_refresh_idempotency: missing }), undefined, `missing ${key}`);
    const wrong = typeof value === "number" ? value + 1 : Array.isArray(value) ? [value[0], value[0]] : `${value}-wrong`;
    assert.equal(await discover({ ...metadata(), concourse_refresh_idempotency: { ...capability(), [key]: wrong } }), undefined, `wrong ${key}`);
  }
  for (const extra of [{ grant_type: "refresh_token" }, { max_reissues_per_exchange: 3 }, { request_parameter: "concourse_refresh_exchange_id" }, { extra: true }]) assert.equal(await discover({ ...metadata(), concourse_refresh_idempotency: { ...capability(), ...extra } }), undefined);
  for (const old of ["concourse_refresh_recovery", "concourse_refresh_recovery_v3"]) {
    for (const value of [null, false, {}, { version: 3 }]) assert.equal(await discover({ ...metadata(), [old]: value }), undefined);
    assert.equal(await discover({ issuer: config.issuer, token_endpoint: config.tokenEndpoint, [old]: capability() }), undefined);
  }
  for (const value of [null, [], {}, true, "header"]) assert.equal(await discover({ ...metadata(), concourse_refresh_idempotency: value }), undefined);
  for (const resources of [[config.origin], [config.origin, `${config.origin}/mcp`, "https://extra.invalid"], [`${config.origin}/`, `${config.origin}/mcp`]]) assert.equal(await discover({ ...metadata(), concourse_refresh_idempotency: { ...capability(), resources } }), undefined);
});

test("ordinary initial discovery failures downgrade, but ownership errors never do", async () => {
  for (const response of [new Response("invalid json"), new Response("refused", { status: 503 }), new Response(null, { status: 302, headers: { location: "https://other.invalid" } })]) {
    assert.equal(await supportsRecovery(config, (async () => response) as Fetch, () => {}), undefined);
  }
  assert.equal(await supportsRecovery(config, (async () => { throw new Error("synthetic transport loss"); }) as Fetch, () => {}), undefined);
  await assert.rejects(supportsRecovery(config, (async () => { throw new SafeError("SESSION_REPLACED"); }) as Fetch, () => {}), /SESSION_REPLACED/);
  let alive = true;
  const guard = () => { if (!alive) throw new SafeError("SESSION_REPLACED"); };
  await assert.rejects(supportsRecovery(config, (async () => { alive = false; return jsonResponse(metadata()); }) as Fetch, guard), /SESSION_REPLACED/);
  alive = true;
  await assert.rejects(supportsRecovery(config, (async () => { alive = false; throw new Error("lost"); }) as Fetch, () => { if (!alive) throw new SafeError("SESSION_REPLACED"); }), /SESSION_REPLACED/);
});

test("new journals use canonical UUIDv4 operation and owner IDs, local v4 and wire v1", () => {
  const j = journal(), another = journal();
  assert.match(j.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(j.id, another.id); assert.equal(j.version, 4); assert.equal(j.ownerEpoch, epoch);
  assert.equal(j.dispatches, 1); assert.equal(j.conflictRetries, 0); assert.equal(j.phase, "dispatch-uncertain");
  assert.equal(j.parentFingerprint, fingerprint("opaque:parent! with space"));
  assert.deepEqual(parseExchange(j, binding), j); assert.notStrictEqual(j.binding, binding);
  assert.equal(readReceipt(j).version, 1);
  for (const bad of [epoch.toUpperCase(), epoch.replace("-42d3-", "-12d3-"), epoch.replace("-a456-", "-7456-"), "A".repeat(43), `${epoch}\n`, ""]) {
    assert.throws(() => newExchange(binding, "parent", bad), safeCode("INVALID_REFRESH_EXCHANGE"));
    assert.equal(parseExchange({ ...j, id: bad }, binding), undefined);
    assert.equal(parseExchange({ ...j, ownerEpoch: bad }, binding), undefined);
    assert.throws(() => reserveDispatch(j, bad), safeCode("INVALID_REFRESH_EXCHANGE"));
  }
});

test("markRequest leaves the form unchanged and emits quoted key plus unquoted ordinal", () => {
  for (let dispatches = 1; dispatches <= 8; dispatches++) {
    const j = { ...journal(), dispatches } as RefreshExchange;
    const form = new URLSearchParams("grant_type=refresh_token&refresh_token=synthetic&repeat=a&repeat=b");
    const before = form.toString();
    const headers: Record<string, string> = { accept: "application/json", "idempotency-key": "old", "CONCOURSE-REFRESH-DISPATCH": "old" };
    markRequest(cap, j, form, headers);
    assert.equal(form.toString(), before);
    assert.deepEqual(headers, { accept: "application/json", "Idempotency-Key": `"${j.id}"`, "Concourse-Refresh-Dispatch": String(dispatches) });
  }
  const bad = { ...journal(), id: `${epoch}\r\nInjected: value` };
  assert.throws(() => markRequest(cap, bad, new URLSearchParams(), {}), safeCode("INVALID_REFRESH_EXCHANGE"));
  for (const unsupported of [{ header: "idempotency-key", dispatch_header: cap.dispatch_header }, { ...cap, version_parameter: "old" }, { request_parameter: "old", version_parameter: "old" }]) {
    assert.throws(() => markRequest(unsupported as RecoveryCapability, journal(), new URLSearchParams(), {}), safeCode("INVALID_REFRESH_EXCHANGE"));
  }
});

test("dispatches and generations have separate bounds; every reservation counts and adopts the epoch", () => {
  assert.equal(MAX_DISPATCHES, 8); assert.equal(MAX_CONFLICT_RETRIES, 4);
  let j = journal();
  const first = structuredClone(j);
  for (let n = 2; n <= 8; n++) {
    assert.equal(resumable(j), true);
    const previous = structuredClone(j);
    j = reserveDispatch(j, nextEpoch);
    assert.equal(j.dispatches, n); assert.equal(j.conflictRetries, 0); assert.equal(j.ownerEpoch, nextEpoch);
    assert.equal(j.phase, "dispatch-uncertain"); assert.equal(j.id, first.id); assert.equal(j.parentFingerprint, first.parentFingerprint);
    assert.notDeepEqual(j, previous);
    assert.equal(readReceipt(j, { ...wire(j), generation: Math.min(4, n) }).generation, Math.min(4, n));
  }
  assert.equal(resumable(j), false);
  assert.throws(() => reserveDispatch(j, epoch), /OAUTH_EXCHANGE_UNCERTAIN/);
  for (const phase of ["processing", "committing", "refused", "locked"] as const) assert.equal(resumable({ ...first, phase }), false);
  assert.equal(resumable({ ...first, phase: "retry-eligible" }), true);
  assert.deepEqual(first, { ...first, dispatches: 1, conflictRetries: 0, ownerEpoch: epoch });
});

test("four 409-triggered reservations exhaust conflict budget after five POSTs", () => {
  let j = journal();
  for (let n = 1; n <= 4; n++) {
    const cause: RefreshExchange = { ...j, phase: "conflict" };
    assert.equal(resumable(cause), true);
    j = reserveDispatch(cause, epoch);
    assert.equal(j.dispatches, n + 1); assert.equal(j.conflictRetries, n); assert.equal(j.phase, "dispatch-uncertain");
    j = parseExchange(JSON.parse(JSON.stringify(j)), binding)!;
  }
  const exhausted: RefreshExchange = { ...j, phase: "conflict" };
  assert.equal(exhausted.dispatches, 5); assert.equal(resumable(exhausted), false);
  assert.throws(() => reserveDispatch(exhausted, nextEpoch), /OAUTH_EXCHANGE_UNCERTAIN/);
  // The fifth POST losing transport instead of returning 409 permits transport
  // retries within total8, without charging a fifth conflict or refunding one.
  assert.equal(resumable(j), true);
  while (j.dispatches < 8) j = reserveDispatch({ ...j, phase: "retry-eligible" }, nextEpoch);
  assert.equal(j.dispatches, 8); assert.equal(j.conflictRetries, 4); assert.equal(resumable(j), false);
});

test("transport loss immediately after a conflict reservation does not count the 409 twice", () => {
  const initial = journal();
  const second = reserveDispatch({ ...initial, phase: "conflict" }, nextEpoch);
  const third = reserveDispatch(second, epoch);
  assert.equal(second.conflictRetries, 1); assert.equal(third.conflictRetries, 1);
  assert.equal(third.dispatches, 3); assert.equal(third.ownerEpoch, epoch);
  const fourth = reserveDispatch({ ...third, phase: "conflict" }, nextEpoch);
  assert.equal(fourth.conflictRetries, 2); assert.equal(fourth.dispatches, 4);
  assert.equal(initial.dispatches, 1); assert.equal(initial.conflictRetries, 0);
});

test("journal parsing rejects legacy, unknown, missing and malformed schemas without migration", () => {
  const j = journal();
  const invalid: unknown[] = [null, true, 0, [], {}, { ...j, version: 3 }, { ...j, version: 1 }, { ...j, extra: true }, { ...j, grant: "authorization_code" }, { ...j, phase: "unknown" }, { ...j, commit: undefined }, { ...j, phase: "committing" }];
  for (const key of Object.keys(j)) { const missing = { ...j } as Record<string, unknown>; delete missing[key]; invalid.push(missing); }
  for (const dispatches of [0, 9, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) invalid.push({ ...j, dispatches });
  for (const conflictRetries of [-1, 5, 0.5, "0", null, 1]) invalid.push({ ...j, conflictRetries });
  for (const parentFingerprint of ["A".repeat(64), "a".repeat(63), `${j.parentFingerprint}\n`, null]) invalid.push({ ...j, parentFingerprint });
  for (const value of invalid) {
    assert.equal(parseExchange(value, binding), undefined);
    assert.equal(sameExchange(value, value), false);
    assert.equal(resumable(value as RefreshExchange), false);
  }
  for (const phase of ["dispatch-uncertain", "retry-eligible", "conflict", "processing", "refused", "locked"] as const) assert.ok(parseExchange({ ...j, phase }, binding));
});

test("journals reject altered or malformed bindings even when used as their own expectation", () => {
  const j = journal();
  for (const change of [{ issuer: `${binding.issuer}/` }, { tokenEndpoint: `${binding.tokenEndpoint}?extra=1` }, { resource: "https://other.invalid" }, { scope: "other" }, { clientId: "" }, { clientId: "bad\nclient" }, { organization: "Bad Org" }, { owner: "bad owner" }, { agent: "bad/agent" }, { extra: true }]) {
    const bad = { ...binding, ...change } as typeof binding;
    assert.equal(parseExchange({ ...j, binding: bad }, bad), undefined);
    assert.throws(() => newExchange(bad, "parent", epoch), safeCode("INVALID_REFRESH_EXCHANGE"));
  }
  for (const key of Object.keys(binding)) {
    const missing = { ...binding } as Record<string, unknown>; delete missing[key];
    assert.equal(parseExchange({ ...j, binding: missing }, binding), undefined);
  }
  for (const change of [{ clientId: "other" }, { organization: "other" }, { owner: "other" }, { agent: "other" }]) assert.equal(parseExchange({ ...j, binding: { ...binding, ...change } }, binding), undefined);
});

test("wire success receipts have exact keys, matching operation and dispatch, generation1–4", () => {
  const j = { ...journal(), dispatches: 8 } as RefreshExchange;
  for (const generation of [1, 2, 3, 4]) assert.equal(readReceipt(j, { ...wire(j), generation }).generation, generation);
  const good = wire(j);
  const invalid: unknown[] = [null, [], {}, { ...good, extra: true }];
  for (const key of Object.keys(good)) { const missing = { ...good } as Record<string, unknown>; delete missing[key]; invalid.push(missing); }
  for (const change of [{ version: 4 }, { version: "1" }, { key: epoch }, { key: `"${j.id}"` }, { dispatch: 7 }, { dispatch: "8" }, { generation: 0 }, { generation: 5 }, { generation: 1.5 }, { generation: "1" }, { expires_at: 0 }, { expires_at: -1 }, { expires_at: 1.5 }, { expires_at: "1900000000" }, { expires_at: Number.MAX_SAFE_INTEGER + 1 }]) invalid.push({ ...good, ...change });
  for (const value of invalid) assert.throws(() => readReceipt(j, value), safeCode("INVALID_REFRESH_EXCHANGE_RESPONSE"));
  assert.throws(() => responseReceipt({ concourse_refresh_exchange: good }, j), safeCode("INVALID_REFRESH_EXCHANGE_RESPONSE"));
  const first = journal();
  assert.throws(() => readReceipt(first, { ...wire(first), generation: 2 }), safeCode("INVALID_REFRESH_EXCHANGE_RESPONSE"));
  assert.equal(readReceipt(j, { ...good, expires_at: 1 }).expires_at, 1, "no client-clock window decisions");
  assert.equal(readReceipt(j, { ...good, expires_at: Number.MAX_SAFE_INTEGER }).expires_at, Number.MAX_SAFE_INTEGER);
});

test("commit receipt picks only verified identity fields and records full local evidence", () => {
  const { j, receipt, t } = committing();
  assert.equal(receipt.version, 4); assert.equal(receipt.ownerEpoch, j.ownerEpoch); assert.equal(receipt.dispatch, 3);
  assert.equal(receipt.generation, 1); assert.equal(receipt.windowExpires, wire(j).expires_at);
  assert.equal(receipt.accessFingerprint, fingerprint(t.access)); assert.equal(receipt.successorFingerprint, fingerprint(t.refresh));
  assert.deepEqual(Object.keys(receipt.identity).sort(), ["release_line", "organization", "owner", "handle", "oauth_client_id", "agent_id"].sort());
  assert.equal("network_agent" in receipt.identity, false); assert.equal(receipt.identity.agent_id, 7);
  assert.ok(parseExchange(j, binding));
  assert.equal(committed(j, receipt, t), true, "expired successor access is reconcilable without HTTP");
  assert.notStrictEqual(j.binding, receipt.binding); assert.notStrictEqual(receipt.identity, identity);
  const enriched = { ...identity, client_secret: "synthetic-never-persist", access_token: "synthetic-never-persist" };
  const { commit: _expected, ...processing } = j;
  const picked = commitReceipt({ ...processing, phase: "processing" }, readReceipt(j), enriched, t.access, t.refresh, t.expires);
  assert.equal("client_secret" in picked.identity, false);
});

test("commit construction rejects invalid identity, receipt, token syntax and expiry", () => {
  const j: RefreshExchange = { ...journal(), phase: "processing" }, r = readReceipt(j), t = tokens();
  for (const change of [{ release_line: 4 }, { organization: "other" }, { owner: "other" }, { handle: "other" }, { oauth_client_id: "other" }, { agent_id: 0 }, { agent_id: -1 }, { agent_id: 1.5 }, { agent_id: "7" }, { agent_id: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => commitReceipt(j, r, { ...identity, ...change } as Identity, t.access, t.refresh, t.expires), safeCode("INVALID_REFRESH_EXCHANGE_RESPONSE"));
  }
  for (const key of ["release_line", "organization", "owner", "handle", "oauth_client_id", "agent_id"]) {
    const missing = { ...identity } as Record<string, unknown>; delete missing[key];
    assert.throws(() => commitReceipt(j, r, missing as unknown as Identity, t.access, t.refresh, t.expires), safeCode("INVALID_REFRESH_EXCHANGE_RESPONSE"));
  }
  for (const expires of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => commitReceipt(j, r, identity, t.access, t.refresh, expires), safeCode("INVALID_REFRESH_EXCHANGE_RESPONSE"));
  for (const access of ["", "bad bearer", "bearer\n"]) assert.throws(() => commitReceipt(j, r, identity, access, t.refresh, t.expires), safeCode("INVALID_REFRESH_EXCHANGE_RESPONSE"));
  for (const refresh of ["", "bad\nrefresh", "bad\u007frefresh"]) assert.throws(() => commitReceipt(j, r, identity, t.access, refresh, t.expires), safeCode("INVALID_REFRESH_EXCHANGE_RESPONSE"));
  assert.throws(() => commitReceipt(j, { ...r, generation: 2 }, identity, t.access, t.refresh, t.expires), safeCode("INVALID_REFRESH_EXCHANGE_RESPONSE"));
});

test("committing journals demand an exact self-consistent commit, and no other phase may carry one", () => {
  const { j, receipt } = committing();
  for (const phase of ["processing", "dispatch-uncertain", "retry-eligible", "conflict", "refused", "locked"]) assert.equal(parseExchange({ ...j, phase }, binding), undefined);
  const invalid: unknown[] = [undefined, null, {}, { ...receipt, extra: true }];
  for (const key of Object.keys(receipt)) { const missing = { ...receipt } as Record<string, unknown>; delete missing[key]; invalid.push(missing); }
  for (const change of [{ version: 3 }, { id: epoch }, { ownerEpoch: nextEpoch }, { dispatch: 2 }, { generation: 4 }, { windowExpires: 0 }, { expires: 0 }, { accessFingerprint: "bad" }, { successorFingerprint: "bad" }, { parentFingerprint: fingerprint("different") }, { binding: { ...binding, agent: "other" } }, { identity: { ...receipt.identity, network_agent: "forbidden" } }, { identity: { ...receipt.identity, client_secret: "forbidden" } }, { identity: { ...receipt.identity, agent_id: 0 } }]) invalid.push({ ...receipt, ...change });
  for (const commit of invalid) assert.equal(parseExchange({ ...j, commit }, binding), undefined);
  const unknownIdentity: Record<string, unknown> = { ...receipt.identity }; delete unknownIdentity.agent_id;
  assert.equal(parseExchange({ ...j, commit: { ...receipt, identity: unknownIdentity } }, binding), undefined);
});

test("committed rejects in-range generation, epoch, identity and window tampering", () => {
  const { j, receipt, t } = committing();
  for (const change of [{ generation: 2 }, { ownerEpoch: nextEpoch }, { identity: { ...receipt.identity, agent_id: 8 } }, { windowExpires: receipt.windowExpires + 1 }, { dispatch: 2 }, { expires: 2 }, { accessFingerprint: fingerprint("different") }, { successorFingerprint: fingerprint("different") }, { extra: true }]) assert.equal(committed(j, { ...receipt, ...change }, t), false);
  for (const change of [{ access: "other.access" }, { refresh: "other.refresh" }, { refresh: undefined }, { expires: 2 }, { expires: 0 }]) assert.equal(committed(j, receipt, { ...t, ...change }), false);
  const { commit: _commit, ...bare } = j;
  assert.equal(committed({ ...bare, phase: "processing" }, receipt, t), false);
  assert.equal(committed({ ...j, ownerEpoch: nextEpoch }, receipt, t), false);
  assert.equal(committed({ ...j, commit: { ...receipt, generation: 2 } }, receipt, t), false);
  assert.equal(committed(j, reorder(receipt), t), true);
});

test("sameExchange compares all valid structural fields including phase and commit independent of key order", () => {
  const { j, receipt } = committing();
  assert.equal(sameExchange(j, reorder(j)), true); assert.equal(sameExchange(j, structuredClone(j)), true);
  assert.equal(sameExchange(j, { ...j, commit: { ...receipt, generation: 2 } }), false);
  assert.equal(sameExchange(j, { ...j, commit: { ...receipt, identity: { ...receipt.identity, agent_id: 8 } } }), false);
  const initial = journal();
  for (const change of [{ phase: "retry-eligible" }, { ownerEpoch: nextEpoch }, { dispatches: 2 }, { dispatches: 2, conflictRetries: 1 }, { parentFingerprint: fingerprint("other") }, { binding: { ...binding, agent: "other" } }]) assert.equal(sameExchange(initial, { ...initial, ...change }), false);
  assert.equal(sameExchange(j, { ...j, phase: "processing" }), false, "invalid journals are never equal");
});

test("validated conflict accepts exact wire metadata, human titles and normal UTF-8 media parameters", async () => {
  const j = journal();
  for (const contentType of ["application/problem+json", "application/problem+json; charset=utf-8", "Application/Problem+Json; charset=\"UTF-8\""]) {
    assert.equal(await validatedConflict(conflict(j, { ...problem(j), title: "Different human text" }, { ...conflictHeaders(), "content-type": contentType }), j), undefined);
  }
  assert.equal(await validatedConflict(conflict(j, problem(j), { ...conflictHeaders(), "cache-control": "private, no-store" }), j), undefined);
  const trusted = conflict(j); Object.defineProperty(trusted, "url", { value: config.tokenEndpoint });
  await validatedConflict(trusted, j);
});

test("conflict parser rejects non-409, malformed headers, redirects and wrong endpoint safely", async () => {
  const j = journal();
  for (const status of [200, 400, 401, 403, 408, 422, 429, 500, 503]) await assert.rejects(validatedConflict(conflict(j, problem(j), conflictHeaders(), status), j), safeCode("INVALID_REFRESH_CONFLICT", 409));
  for (const [name, values] of Object.entries({ "content-type": [undefined, "application/json", "text/plain", "application/problem+jsonx", "application/problem+json; charset=bogus", "application/problem+json, application/json"], "cache-control": [undefined, "no-cache", "max-age=0", "no-store=1", "x-no-store"], "retry-after": [undefined, "01", "1.0", "0", "2", "1, 1", "Thu, 05 Nov 2026 00:00:00 GMT"] })) {
    for (const value of values) {
      const headers: Record<string, string> = conflictHeaders();
      if (value === undefined) delete headers[name]; else headers[name] = value;
      await assert.rejects(validatedConflict(conflict(j, problem(j), headers), j), safeCode("INVALID_REFRESH_CONFLICT", 409));
    }
  }
  const wrong = conflict(j); Object.defineProperty(wrong, "url", { value: "https://other.invalid/token" });
  await assert.rejects(validatedConflict(wrong, j), safeCode("INVALID_REFRESH_CONFLICT", 409));
  const redirected = conflict(j); Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(validatedConflict(redirected, j), safeCode("INVALID_REFRESH_CONFLICT", 409));
});

test("conflict parser rejects unknown, missing, token, generation and expiry fields without leaking values", async () => {
  const j = journal(), good = problem(j);
  const invalid: unknown[] = [null, [], "synthetic secret body", {}, { ...good, access_token: "synthetic secret" }, { ...good, refresh_token: "synthetic secret" }, { ...good, generation: 1 }, { ...good, expires_at: 1 }, { ...good, extra: true }];
  for (const key of Object.keys(good)) { const missing = { ...good } as Record<string, unknown>; delete missing[key]; invalid.push(missing); }
  for (const change of [{ type: "urn:other" }, { error: "invalid_grant" }, { status: "409" }, { status: 400 }, { title: 1 }, { title: null }]) invalid.push({ ...good, ...change });
  for (const change of [{ version: 4 }, { version: "1" }, { key: nextEpoch }, { key: `"${j.id}"` }, { dispatch: 2 }, { dispatch: "1" }, { generation: 1 }, { expires_at: 1 }, { access_token: "synthetic secret" }, { extra: true }]) invalid.push({ ...good, concourse_refresh_idempotency: { ...good.concourse_refresh_idempotency, ...change } });
  for (const key of Object.keys(good.concourse_refresh_idempotency)) { const missing = { ...good.concourse_refresh_idempotency } as Record<string, unknown>; delete missing[key]; invalid.push({ ...good, concourse_refresh_idempotency: missing }); }
  for (const nested of [null, [], {}, "bad"]) invalid.push({ ...good, concourse_refresh_idempotency: nested });
  for (const value of invalid) await assert.rejects(validatedConflict(conflict(j, value), j), safeCode("INVALID_REFRESH_CONFLICT", 409));
  await assert.rejects(validatedConflict(new Response(`invalid json ${j.id} synthetic secret`, { status: 409, headers: conflictHeaders() }), j), safeCode("INVALID_REFRESH_CONFLICT", 409));
  const unreadable = conflict(j); unreadable.json = async () => { throw new Error(`synthetic secret ${j.id}`); };
  await assert.rejects(validatedConflict(unreadable, j), safeCode("INVALID_REFRESH_CONFLICT", 409));
});

test("opaque refresh tokens and bearer tokens preserve their distinct syntax", () => {
  assert.equal(validBearer("synthetic.access+/=="), true); assert.equal(validBearer("opaque:refresh with space"), false);
  assert.equal(validRefresh("opaque:refresh with space"), true);
  for (const invalid of ["", "token\n", "token\r\n", "token\u007f", "token\u0080", "a".repeat(16_385), null]) {
    assert.equal(validRefresh(invalid), false); assert.equal(validBearer(invalid), false);
  }
});
