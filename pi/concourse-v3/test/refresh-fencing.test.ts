import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { Health } from "../src/health.ts";
import { TokenClient, type Config } from "../src/auth.ts";
import { PrivateFiles } from "../src/storage.ts";
import { refreshFetch, safeFetch, type Fetch } from "../src/http.ts";
import { newExchange, refreshBinding, type RefreshExchange } from "../src/refresh.ts";
import { config, deferred, identity, profile, response } from "./helpers.ts";

const c: Config = { ...config, origin: "https://concourse.krishnan.ca", issuer: "https://app.krishnan.ca", tokenEndpoint: "https://app.krishnan.ca/oauth/token", authorizationEndpoint: "https://app.krishnan.ca/oauth/authorize", auth: { kind: "oauth", redirectUri: "http://127.0.0.1:4555/callback" } };
const metadata = { issuer: c.issuer, token_endpoint: c.tokenEndpoint, concourse_refresh_idempotency: { version: 1, header: "Idempotency-Key", key_format: "sf-string-uuid-v4", dispatch_header: "Concourse-Refresh-Dispatch", window_seconds: 86400, max_dispatches_per_exchange: 8, max_reissues: 3, max_conflict_retries: 4, mode: "replace_unconsumed_successor", successor_consumption: "refresh_token_rotation", late_request_behavior: "reject_without_family_revocation", scope: "concourse", resources: [c.origin, `${c.origin}/mcp`] } };
const old = { access: "old.access", refresh: "parent.refresh", expires: 1, resource: c.origin, clientId: c.oauthClientId, issuer: c.issuer };
const success = (h: Headers, label = "new") => ({ access_token: `${label}.access`, refresh_token: `${label}.refresh`, token_type: "Bearer", expires_in: 3600, scope: "concourse", ...(h.has("idempotency-key") ? { concourse_refresh_idempotency: { version: 1, key: JSON.parse(h.get("idempotency-key")!), dispatch: Number(h.get("concourse-refresh-dispatch")), generation: 1, expires_at: 1900000000 } } : {}) });
function fixture() {
  const p = profile(); let release = p.files.acquire();
  p.files.write("tokens.json", old);
  const requests: Headers[] = [];
  const entered = deferred<void>();
  const hooks = { post: async (h: Headers): Promise<Response> => response(success(h)), identity: async (): Promise<Response> => response(identity) };
  const transport: Fetch = async (url, init) => {
    assert.equal(init?.redirect, new Headers(init?.headers).has("Idempotency-Key") ? "manual" : "error");
    if (String(url) === `${c.issuer}/.well-known/oauth-authorization-server`) return response(metadata);
    if (String(url) === c.tokenEndpoint) { const h = new Headers(init?.headers); requests.push(h); entered.resolve(); return hooks.post(h); }
    assert.equal(String(url), `${c.origin}/api/identity`); return hooks.identity();
  };
  return { ...p, requests, entered, hooks, transport, client: () => new TokenClient(c, p.files, transport, () => 1000000), reacquire: () => { release(); release = p.files.acquire(); }, journal: () => p.files.read<RefreshExchange>("oauth-exchange.json")!, cleanup: () => { release(); p.cleanup(); } };
}

test("OAuth dispatch and authorization intent require the actual profile lock", async () => {
  const p = profile(); let calls = 0;
  try {
    p.files.write("tokens.json", old);
    const client = new TokenClient(c, p.files, async () => { calls++; return response({}); });
    await assert.rejects(client.token(), /consumer lock/);
    assert.throws(() => client.authorizationUrl({ fresh: true }), /consumer lock/);
    assert.equal(calls, 0); assert.equal(p.files.read("oauth-exchange.json"), undefined);
  } finally { p.cleanup(); }
});

test("durable epochs change on reacquisition; double acquisition does not lose the held lock", () => {
  const p = profile(); let release = p.files.acquire();
  try {
    const first = p.files.consumerEpoch();
    assert.equal(p.files.read<{ epoch: string }>("oauth-owner.json")!.epoch, first);
    assert.equal(statSync(join(p.root, "oauth-owner.json")).mode & 0o777, 0o600);
    assert.throws(() => p.files.acquire(), /already owned/); assert.equal(p.files.consumerEpoch(), first);
    const other = new PrivateFiles(p.root);
    try { assert.throws(() => other.acquire(), /already owned/); } finally { other.close(); }
    release(); release = p.files.acquire(); assert.notEqual(p.files.consumerEpoch(), first);
  } finally { release(); p.cleanup(); }
});

for (const late of ["success", "400", "409", "invalid-json", "transport-loss"] as const) test(`old owner ${late} cannot mutate a newer healthy commit after same-object reacquisition`, async () => {
  const f = fixture(), gate = deferred<Response>(); let first: Headers | undefined;
  try {
    f.hooks.post = async h => { if (f.requests.length === 1) { first = h; return gate.promise; } return response(success(h)); };
    const prior = f.client().token(); void prior.catch(() => {}); await f.entered.promise;
    const firstEpoch = f.journal().ownerEpoch;
    f.reacquire(); assert.notEqual(f.files.consumerEpoch(), firstEpoch);
    assert.equal(await f.client().token(), "new.access");
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].get("idempotency-key"), f.requests[1].get("idempotency-key"));
    assert.equal(f.requests[1].get("concourse-refresh-dispatch"), "2");
    const tokens = f.files.read("tokens.json");
    if (late === "transport-loss") gate.reject(new Error("synthetic loss"));
    else gate.resolve(late === "success" ? response(success(first!, "stale")) : late === "invalid-json" ? new Response("{", { headers: { "content-type": "application/json" } }) : response({ error: "old refusal" }, Number(late)));
    await assert.rejects(prior, /OAUTH_RESPONSE_SUPERSEDED/);
    assert.deepEqual(f.files.read("tokens.json"), tokens); assert.equal(f.files.read("oauth-exchange.json"), false);
    assert.equal(f.client().exchangeState(), "clear");
  } finally { f.cleanup(); }
});

for (const late of ["success", "400", "409", "invalid-json"] as const) test(`same-owner superseded ordinal rejects late ${late} without fencing newer output`, async () => {
  const f = fixture(), gate = deferred<Response>(); let first: Headers | undefined;
  try {
    f.hooks.post = async h => { if (f.requests.length === 1) { first = h; return gate.promise; } return response(success(h)); };
    const prior = f.client().token(); void prior.catch(() => {}); await f.entered.promise;
    const epoch = f.files.consumerEpoch();
    assert.equal(await f.client().token(), "new.access"); assert.equal(f.files.consumerEpoch(), epoch);
    const tokens = f.files.read("tokens.json");
    gate.resolve(late === "success" ? response(success(first!, "stale")) : late === "invalid-json" ? new Response("{") : response({}, Number(late)));
    await assert.rejects(prior, /OAUTH_RESPONSE_SUPERSEDED/);
    assert.deepEqual(f.files.read("tokens.json"), tokens); assert.equal(f.files.read("oauth-exchange.json"), false);
  } finally { f.cleanup(); }
});

test("a replaced journal cannot be locked by a late authenticated refusal", async () => {
  const f = fixture(), gate = deferred<Response>();
  try {
    f.hooks.post = async () => gate.promise;
    const prior = f.client().token(); void prior.catch(() => {}); await f.entered.promise;
    const newer = newExchange(refreshBinding(c), old.refresh, f.files.consumerEpoch());
    f.files.write("oauth-exchange.json", newer); gate.resolve(response({ error: "invalid_grant" }, 400));
    await assert.rejects(prior, /OAUTH_RESPONSE_SUPERSEDED/);
    assert.deepEqual(f.files.read("oauth-exchange.json"), newer); assert.deepEqual(f.files.read("tokens.json"), old);
  } finally { f.cleanup(); }
});

test("parse failure after a journal replacement performs no response-induced write", async () => {
  const f = fixture(), write = f.files.write.bind(f.files); let newer: RefreshExchange | undefined;
  try {
    f.hooks.post = async () => new Response("{", { headers: { "content-type": "application/json" } });
    f.files.write = (name, value) => {
      write(name, value);
      if (name === "oauth-exchange.json" && (value as RefreshExchange)?.phase === "processing") queueMicrotask(() => { newer = newExchange(refreshBinding(c), old.refresh, f.files.consumerEpoch()); write("oauth-exchange.json", newer); });
    };
    await assert.rejects(f.client().token(), /OAUTH_RESPONSE_SUPERSEDED/);
    assert.ok(newer); assert.deepEqual(f.files.read("oauth-exchange.json"), newer); assert.deepEqual(f.files.read("tokens.json"), old);
  } finally { f.files.write = write; f.cleanup(); }
});

test("a fresh verified PKCE commit supersedes an older pending identity response", async () => {
  const f = fixture(), gate = deferred<Response>(), identityEntered = deferred<void>(); let checks = 0;
  try {
    f.hooks.identity = async () => { checks++; if (checks === 1) { identityEntered.resolve(); return gate.promise; } return response(identity); };
    const prior = f.client().token(); void prior.catch(() => {}); await identityEntered.promise;
    const oldFence = f.files.read("oauth-exchange.json");
    const fresh = f.client(), url = new URL(fresh.authorizationUrl({ fresh: true }));
    assert.deepEqual(f.files.read("oauth-exchange.json"), oldFence);
    await fresh.completeAuthorization({ code: "fresh-code", state: url.searchParams.get("state")!, iss: c.issuer });
    const tokens = f.files.read("tokens.json");
    gate.resolve(response({ ...identity, owner: "wrong" }));
    await assert.rejects(prior, /OAUTH_RESPONSE_SUPERSEDED/);
    assert.deepEqual(f.files.read("tokens.json"), tokens); assert.equal(f.files.read("oauth-exchange.json"), false); assert.equal(f.files.read("oauth-code-exchange.json"), false);
  } finally { f.cleanup(); }
});

test("a failed new PKCE exchange retains the original refresh journal and blocks its resumption", async () => {
  const f = fixture();
  try {
    f.hooks.post = async () => { throw new Error("lost refresh"); };
    await assert.rejects(f.client().token(), /TRANSPORT_FAILED/); const oldFence = f.files.read("oauth-exchange.json");
    const fresh = f.client(), url = new URL(fresh.authorizationUrl({ fresh: true }));
    await assert.rejects(fresh.completeAuthorization({ code: "fresh-code", state: url.searchParams.get("state")!, iss: c.issuer }), /TRANSPORT_FAILED/);
    assert.deepEqual(f.files.read("oauth-exchange.json"), oldFence);
    assert.equal(f.client().exchangeState(), "fenced");
    await assert.rejects(f.client().token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.requests.length, 2);
  } finally { f.cleanup(); }
});

for (const stage of ["before", "after"] as const) test(`owner-epoch persistence failure ${stage} write releases the failed acquisition`, () => {
  const p = profile(), write = p.files.write.bind(p.files);
  try {
    p.files.write = (name, value) => { if (name === "oauth-owner.json") { if (stage === "after") write(name, value); throw new Error("synthetic epoch persistence failure"); } write(name, value); };
    assert.throws(() => p.files.acquire(), /epoch persistence failure/); assert.equal(p.files.ownsConsumer(), false);
    const other = new PrivateFiles(p.root);
    try { const release = other.acquire(); assert.ok(other.consumerEpoch()); release(); } finally { other.close(); }
  } finally { p.files.write = write; p.cleanup(); }
});

for (const status of [204, 400, 408, 429, 500, 503]) test(`known HTTP ${status} cannot become a lost-response retry when its body is broken`, async () => {
  const f = fixture();
  try {
    f.hooks.post = async () => status === 204 ? new Response(null, { status }) : new Response(new ReadableStream({ start(controller) { controller.error(new Error("body broken")); } }), { status });
    await assert.rejects(f.client().token()); assert.notEqual(f.client().exchangeState(), "resumable");
    await assert.rejects(f.client().token()); assert.equal(f.requests.length, 1);
  } finally { f.cleanup(); }
});

test("the narrow refresh 409 reader does not change ordinary HTTP error-body handling", async () => {
  const body = { type: "urn:ajent:oauth:refresh-idempotency-in-progress", error: "concourse_refresh_in_progress" };
  const transport: Fetch = async () => response(body, 409);
  await assert.rejects(safeFetch(c.origin, transport)(`${c.origin}/api/tasks`, { method: "POST" }), /HTTP_REFUSED_409/);
  const r = await refreshFetch(c.tokenEndpoint, transport)(c.tokenEndpoint, { method: "POST" }); assert.equal(r.status, 409);
  await assert.rejects(refreshFetch(c.tokenEndpoint, transport)(`${c.issuer}/other`, { method: "POST" }), /HTTP_REFUSED_409/);
  await assert.rejects(refreshFetch(c.tokenEndpoint, transport)(c.tokenEndpoint, { method: "GET" }), /HTTP_REFUSED_409/);
  const wrongPath: Fetch = async () => { const r = response(body, 409); Object.defineProperty(r, "url", { value: `${c.issuer}/other` }); return r; };
  await assert.rejects(refreshFetch(c.tokenEndpoint, wrongPath)(c.tokenEndpoint, { method: "POST" }), /DESTINATION_REFUSED/);
});

test("a real crashed process retains its reservation and next owner adopts only the epoch", async () => {
  const p = profile(); let posts = 0;
  const auth = new URL("../src/auth.ts", import.meta.url).href, storage = new URL("../src/storage.ts", import.meta.url).href;
  const source = `import {TokenClient} from ${JSON.stringify(auth)}; import {PrivateFiles} from ${JSON.stringify(storage)};
    const c=${JSON.stringify(c)}, files=new PrivateFiles(${JSON.stringify(p.root)}); files.acquire(); files.write('tokens.json',${JSON.stringify(old)});
    const transport=async(url,init)=>{if(String(url).includes('/.well-known/'))return Response.json(${JSON.stringify(metadata)}); if(init.method==='POST')throw new Error('synthetic lost response'); throw new Error('unexpected route');};
    try { await new TokenClient(c,files,transport,()=>1000000).token(); process.exit(8); } catch(e) { if(e.code!=='TRANSPORT_FAILED')throw e; process.send('reserved'); process.exit(7); }`;
  const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let diagnostics = ""; child.stderr?.on("data", b => { diagnostics += String(b); });
  try {
    const exited = once(child, "exit");
    await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Child exited before reservation: ${diagnostics}`); })]);
    assert.equal((await exited)[0], 7);
    const before = p.files.read<RefreshExchange>("oauth-exchange.json")!;
    assert.equal(before.dispatches, 1); assert.equal(before.conflictRetries, 0); assert.equal(before.phase, "retry-eligible");
    const release = p.files.acquire();
    try {
      assert.notEqual(p.files.consumerEpoch(), before.ownerEpoch);
      const transport: Fetch = async (url, init) => {
        if (String(url).includes("/.well-known/")) return response(metadata);
        if (String(url) === c.tokenEndpoint) {
          posts++; const h = new Headers(init?.headers), j = p.files.read<RefreshExchange>("oauth-exchange.json")!;
          assert.equal(j.id, before.id); assert.equal(j.dispatches, 2); assert.equal(j.conflictRetries, 0); assert.equal(j.ownerEpoch, p.files.consumerEpoch());
          return response(success(h));
        }
        assert.equal(String(url), `${c.origin}/api/identity`); return response(identity);
      };
      assert.equal(await new TokenClient(c, p.files, transport, () => 1000000).token(), "new.access");
      assert.equal(posts, 1); assert.equal(p.files.read("oauth-exchange.json"), false);
    } finally { release(); }
  } finally { p.cleanup(); }
});

test("an old health generation cannot overwrite the new owner's health after same-object reacquisition", () => {
  const p = profile(); let release = p.files.acquire();
  try {
    const oldHealth = new Health(p.files, c, "old-session", () => {}); oldHealth.write();
    release(); release = p.files.acquire();
    const newHealth = new Health(p.files, c, "new-session", () => {}); newHealth.write();
    const saved = p.files.read("health.json");
    assert.throws(() => oldHealth.failure("identity", new Error("late old failure")), /HEALTH_OWNERSHIP_LOST/);
    assert.throws(() => oldHealth.stop(), /HEALTH_OWNERSHIP_LOST/);
    assert.deepEqual(p.files.read("health.json"), saved);
  } finally { release(); p.cleanup(); }
});

for (const status of [301, 302, 303, 307, 308]) test(`native-fetch HTTP ${status} is never followed or retried as transport loss`, async () => {
  const f = fixture(); let posts = 0, followed = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === "/never-follow") { followed++; res.end(); return; }
    assert.equal(req.method, "POST"); posts++; res.writeHead(status, { location: "/never-follow" }); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const transport: Fetch = async (url, init) => String(url) === c.tokenEndpoint
    ? fetch(`http://127.0.0.1:${address.port}/token`, init) : f.transport(url, init);
  const client = new TokenClient(c, f.files, transport, () => 1000000);
  try {
    await assert.rejects(client.token(), /REDIRECT_REFUSED/);
    assert.equal(f.journal().phase, "locked"); assert.equal(f.journal().dispatches, 1);
    await assert.rejects(client.token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(posts, 1); assert.equal(followed, 0); assert.deepEqual(f.files.read("tokens.json"), old);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); }
});
