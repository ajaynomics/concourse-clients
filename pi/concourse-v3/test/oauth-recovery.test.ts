import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TokenClient, type Config } from "../src/auth.ts";
import { SafeError, type Fetch } from "../src/http.ts";
import { config, deferred, identity, profile, response } from "./helpers.ts";
import { newExchange, refreshBinding } from "../src/refresh.ts";
import { PrivateFiles } from "../src/storage.ts";

const oauth: Config = { ...config, authorizationEndpoint: "https://issuer.invalid/authorize", auth: { kind: "oauth", redirectUri: "http://127.0.0.1:4555/callback" } };
const old = { access: "old.access", refresh: "old.rotating", expires: 1, resource: config.origin, clientId: config.oauthClientId, issuer: config.issuer };
const issued = { access_token: "new.access", refresh_token: "new.rotating", token_type: "Bearer", expires_in: 3600, scope: "concourse" };
const callback = (url: string) => ({ code: "new.code", state: new URL(url).searchParams.get("state")!, iss: config.issuer });

test("explicit fresh PKCE sign-in supersedes an old intent, not its durable refresh fence", async () => {
  const p = profile(); let posts = 0;
  try {
    p.files.acquire();
    p.files.write("tokens.json", old);
    const client = new TokenClient(oauth, p.files, async (_url, init) => {
      if (String(_url) === `${config.origin}/api/identity`) return response(identity);
      assert.equal(String(_url), config.tokenEndpoint); assert.equal(init?.method, "POST");
      posts++;
      assert.equal(p.files.read("oauth-exchange.json"), true);
      assert.equal(p.files.read("oauth-pending.json"), null);
      assert.deepEqual(p.files.read("tokens.json"), old);
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("refresh_token"), null);
      assert.equal(body.get("client_id"), config.oauthClientId);
      assert.equal(body.get("resource"), config.origin);
      assert.equal(body.get("redirect_uri"), oauth.auth.kind === "oauth" ? oauth.auth.redirectUri : "");
      assert.equal(init?.redirect, "error");
      return response(issued);
    });
    const stale = client.authorizationUrl();
    p.files.write("oauth-exchange.json", true); // Old boolean markers need no migration/reset.
    assert.throws(() => client.authorizationUrl(), /OAUTH_EXCHANGE_UNCERTAIN/);
    const fresh = client.authorizationUrl({ fresh: true });
    const params = new URL(fresh).searchParams;
    const pending = p.files.read<{ verifier: string }>("oauth-pending.json")!;
    assert.notEqual(params.get("state"), new URL(stale).searchParams.get("state"));
    assert.notEqual(params.get("code_challenge"), new URL(stale).searchParams.get("code_challenge"));
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.equal(params.get("code_challenge"), createHash("sha256").update(pending.verifier).digest("base64url"));
    assert.equal(p.files.read("oauth-exchange.json"), true);
    await assert.rejects(client.token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    await assert.rejects(client.completeAuthorization(callback(stale)), /OAUTH_CALLBACK_REFUSED/);
    for (const bad of [{ ...callback(fresh), state: "wrong" }, { ...callback(fresh), iss: "https://other.invalid" }, { ...callback(fresh), iss: undefined }]) {
      await assert.rejects(client.completeAuthorization(bad), /OAUTH_CALLBACK_REFUSED/);
    }
    assert.equal(posts, 0);
    await client.completeAuthorization(callback(fresh), async access => {
      assert.equal(access, issued.access_token);
      assert.equal(p.files.read("oauth-exchange.json"), true);
      assert.deepEqual(p.files.read("tokens.json"), old);
    });
    assert.equal(posts, 1);
    assert.equal(p.files.read("oauth-exchange.json"), false);
    assert.equal(p.files.read("oauth-code-exchange.json"), false);
    const saved = p.files.read<{ codeCommit: { identity: unknown }; access: string; refresh: string; resource: string; clientId: string; issuer: string }>("tokens.json")!;
    const { network_agent: _network, ...verified } = identity;
    assert.deepEqual(saved.codeCommit.identity, verified);
    assert.deepEqual({ access: saved.access, refresh: saved.refresh, resource: saved.resource, clientId: saved.clientId, issuer: saved.issuer }, { access: issued.access_token, refresh: issued.refresh_token, resource: old.resource, clientId: old.clientId, issuer: old.issuer });
    assert.equal(await new TokenClient(oauth, p.files, async () => assert.fail("No request needed")).token(), issued.access_token);
    await assert.rejects(client.completeAuthorization(callback(fresh)), /OAUTH_CALLBACK_REFUSED/);
    assert.equal(posts, 1);
  } finally { p.cleanup(); }
});

const failures: [string, Fetch][] = [
  ["DNS-shaped rejection", async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }],
  ["connect-shaped rejection", async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }],
  ["lost response", async () => { throw new Error("synthetic response lost after request"); }],
  ["server error", async () => response({}, 503)],
  ["refusal", async () => response({}, 400)],
  ["redirect", async () => response({}, 302)],
  ["malformed JSON", async () => new Response("not JSON")],
  ["invalid token response", async () => response({ ...issued, token_type: "wrong" })],
];
for (const [name, fail] of failures) test(`${name} never permits refresh/code replay, but a new explicit authorization can recover`, async () => {
  const p = profile(); let calls = 0;
  try {
    p.files.acquire();
    p.files.write("tokens.json", old);
    const broken = new TokenClient(oauth, p.files, async (...args) => { calls++; return fail(...args); });
    await assert.rejects(broken.token());
    assert.equal(p.files.read("oauth-exchange.json"), true);
    await assert.rejects(broken.token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(calls, 1);
    const attempted = broken.authorizationUrl({ fresh: true });
    await assert.rejects(broken.completeAuthorization(callback(attempted)));
    assert.equal(calls, 2);
    assert.equal(p.files.read("oauth-pending.json"), null);
    assert.equal(p.files.read("oauth-exchange.json"), true);
    assert.deepEqual(p.files.read("tokens.json"), old);
    assert.equal(p.files.read<{ phase: string }>("oauth-code-exchange.json")!.phase, "dispatch-uncertain");
    assert.equal(broken.exchangeState(), "fenced");
    const restarted = new TokenClient(oauth, p.files, async (_url, init) => {
      if (String(_url) === `${config.origin}/api/identity`) return response(identity);
      assert.equal(String(_url), config.tokenEndpoint); assert.equal(init?.method, "POST");
      calls++;
      assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "authorization_code");
      return response(issued);
    });
    await assert.rejects(restarted.completeAuthorization(callback(attempted)), /OAUTH_CALLBACK_REFUSED/);
    const fresh = restarted.authorizationUrl({ fresh: true });
    assert.notEqual(callback(fresh).state, callback(attempted).state);
    await assert.rejects(restarted.completeAuthorization(callback(attempted)), /OAUTH_CALLBACK_REFUSED/);
    await restarted.completeAuthorization(callback(fresh));
    assert.equal(calls, 3);
    assert.equal(await restarted.token(), issued.access_token);
  } finally { p.cleanup(); }
});

test("fresh sign-in does not overlap an active refresh, code exchange or identity acceptance", async () => {
  const p = profile(), network = deferred<Response>(), accept = deferred<void>(); let calls = 0;
  try {
    p.files.acquire();
    p.files.write("tokens.json", old);
    const client = new TokenClient(oauth, p.files, async (url, init) => {
      if (String(url) === `${config.origin}/api/identity`) return response(identity);
      assert.equal(String(url), config.tokenEndpoint); assert.equal(init?.method, "POST");
      calls++; return calls === 1 ? network.promise : response(issued);
    });
    const stale = client.authorizationUrl();
    const refreshing = client.token();
    // Discovery is asynchronous even when this synthetic issuer has no recovery capability.
    await Promise.resolve();
    const failedRefresh = assert.rejects(refreshing, /TRANSPORT_FAILED/);
    assert.throws(() => client.authorizationUrl({ fresh: true }), /OAUTH_EXCHANGE_IN_PROGRESS/);
    await assert.rejects(client.completeAuthorization(callback(stale)), /OAUTH_EXCHANGE_IN_PROGRESS/);
    network.reject(new Error("lost")); await failedRefresh;
    const fresh = client.authorizationUrl({ fresh: true });
    const entered = deferred<void>();
    const exchange = client.completeAuthorization(callback(fresh), async () => { entered.resolve(); await accept.promise; });
    await entered.promise;
    assert.throws(() => client.authorizationUrl({ fresh: true }), /OAUTH_EXCHANGE_IN_PROGRESS/);
    await assert.rejects(client.completeAuthorization(callback(fresh)), /OAUTH_EXCHANGE_IN_PROGRESS/);
    await assert.rejects(client.token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.deepEqual(p.files.read("tokens.json"), old);
    accept.resolve(); await exchange;
    assert.equal(calls, 2);
    assert.equal(await client.token(), issued.access_token);
  } finally { p.cleanup(); }
});

test("identity rejection and stale ownership cannot save recovered tokens or clear uncertainty", async () => {
  for (const mode of ["identity", "generation"]) {
    const p = profile(); let alive = true;
    try {
      p.files.acquire();
      const originalFence = { ...newExchange({ ...refreshBinding(oauth), issuer: "https://app.krishnan.ca", tokenEndpoint: "https://app.krishnan.ca/oauth/token", resource: "https://concourse.krishnan.ca" }, old.refresh, p.files.consumerEpoch()), phase: "locked" };
      p.files.write("tokens.json", old); p.files.write("oauth-exchange.json", originalFence);
      const client = new TokenClient(oauth, p.files, async (url, init) => {
        if (String(url) === `${config.origin}/api/identity`) return response(identity);
        assert.equal(String(url), config.tokenEndpoint); assert.equal(init?.method, "POST"); return response(issued);
      }, Date.now, () => { if (!alive) throw new SafeError("SESSION_REPLACED"); });
      const fresh = client.authorizationUrl({ fresh: true });
      await assert.rejects(client.completeAuthorization(callback(fresh), async () => {
        if (mode === "identity") throw new SafeError("V3_IDENTITY_REFUSED");
        alive = false;
      }), mode === "identity" ? /V3_IDENTITY_REFUSED/ : /SESSION_REPLACED/);
      assert.deepEqual(p.files.read("tokens.json"), old);
      assert.deepEqual(p.files.read("oauth-exchange.json"), originalFence);
      assert.equal(p.files.read<{ phase: string }>("oauth-code-exchange.json")!.phase, "dispatch-uncertain");
      assert.equal(client.exchangeState(), "fenced");
      assert.equal(p.files.read("oauth-pending.json"), null);
    } finally { p.cleanup(); }
  }
});

test("fresh recovery still refuses expired callbacks and changed credential/pending bindings", async () => {
  const p = profile(); let now = 1000;
  try {
    p.files.acquire();
    p.files.write("tokens.json", old); p.files.write("oauth-exchange.json", true);
    const client = new TokenClient(oauth, p.files, async () => assert.fail("No request permitted"), () => now);
    const fresh = client.authorizationUrl({ fresh: true });
    now += 900_001;
    await assert.rejects(client.completeAuthorization(callback(fresh)), /OAUTH_CALLBACK_REFUSED/);
    p.files.write("tokens.json", { ...old, clientId: "other" });
    assert.throws(() => client.authorizationUrl({ fresh: true }), /TOKEN_BINDING_MISMATCH/);
    p.files.write("tokens.json", old);
    const pending = p.files.read<Record<string, unknown>>("oauth-pending.json")!;
    p.files.write("oauth-pending.json", { ...pending, issuer: "https://other.invalid" });
    assert.throws(() => client.authorizationUrl({ fresh: true }), /OAUTH_PENDING_BINDING_MISMATCH/);
    assert.equal(p.files.read("oauth-exchange.json"), true);
  } finally { p.cleanup(); }
});

test("a failed recovered-token save consumes its code but keeps the old token and fence", async () => {
  const p = profile(); let posts = 0;
  const write = p.files.write.bind(p.files);
  try {
    p.files.acquire();
    p.files.write("tokens.json", old); p.files.write("oauth-exchange.json", true);
    const fetchImpl: Fetch = async (url, init) => {
      if (String(url) === `${config.origin}/api/identity`) return response(identity);
      assert.equal(String(url), config.tokenEndpoint); assert.equal(init?.method, "POST"); posts++; return response(issued);
    };
    const client = new TokenClient(oauth, p.files, fetchImpl);
    const fresh = client.authorizationUrl({ fresh: true });
    p.files.write = (name, value) => { if (name === "tokens.json") throw new Error("synthetic disk failure"); write(name, value); };
    await assert.rejects(client.completeAuthorization(callback(fresh)), /synthetic disk failure/);
    assert.equal(posts, 1);
    assert.deepEqual(p.files.read("tokens.json"), old);
    assert.equal(p.files.read("oauth-exchange.json"), true);
    assert.equal(p.files.read("oauth-pending.json"), null);
    p.files.write = write;
    await assert.rejects(client.completeAuthorization(callback(fresh)), /OAUTH_STORAGE_UNCERTAIN/);
    assert.throws(() => client.token(), /OAUTH_STORAGE_UNCERTAIN/);
    assert.throws(() => client.authorizationUrl({ fresh: true }), /OAUTH_STORAGE_UNCERTAIN/);
    const restarted = new TokenClient(oauth, p.files, fetchImpl);
    assert.equal(p.files.read<{ phase: string }>("oauth-code-exchange.json")!.phase, "committing");
    assert.equal(restarted.exchangeState(), "fenced");
    await assert.rejects(restarted.token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    await assert.rejects(restarted.completeAuthorization(callback(fresh)), /OAUTH_CALLBACK_REFUSED/);
    assert.equal(posts, 1);
    const next = restarted.authorizationUrl({ fresh: true });
    await restarted.completeAuthorization(callback(next));
    assert.equal(posts, 2);
  } finally { p.files.write = write; p.cleanup(); }
});

for (const boundary of ["oauth-exchange.json", "oauth-code-exchange.json"]) test(`${boundary} clear failure after token commit preserves credentials without permitting replay`, async () => {
  const p = profile(); let posts = 0, now = 1000;
  const write = p.files.write.bind(p.files);
  try {
    const release = p.files.acquire();
    write("tokens.json", old); write("oauth-exchange.json", true);
    const client = new TokenClient(oauth, p.files, async (url, init) => {
      if (String(url) === `${config.origin}/api/identity`) return response(identity);
      assert.equal(String(url), config.tokenEndpoint); assert.equal(init?.method, "POST"); posts++; return response(issued);
    }, () => now);
    const fresh = client.authorizationUrl({ fresh: true });
    p.files.write = (name, value) => { if (name === boundary && value === false) throw new Error("synthetic fence-clear failure"); write(name, value); };
    let accepted = false;
    await assert.rejects(client.completeAuthorization(callback(fresh), async () => { accepted = true; }), /fence-clear failure/);
    assert.equal(accepted, true);
    assert.equal(p.files.read<{ access: string }>("tokens.json")!.access, issued.access_token);
    assert.equal(p.files.read("oauth-exchange.json"), boundary === "oauth-exchange.json");
    assert.equal(p.files.read<{ phase: string }>("oauth-code-exchange.json")!.phase, "committing");
    assert.equal(p.files.read("oauth-pending.json"), null);
    p.files.write = write;
    assert.throws(() => client.token(), /OAUTH_STORAGE_UNCERTAIN/);
    const resume = () => new TokenClient(oauth, p.files, async (_url, init) => {
      assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
      posts++; throw new Error("synthetic refresh lost");
    }, () => now);
    let restarted = resume();
    assert.equal(restarted.exchangeState(), "clear");
    release();
    assert.throws(() => restarted.token(), /OAUTH_RESPONSE_SUPERSEDED/);
    assert.equal(p.files.read<{ phase: string }>("oauth-code-exchange.json")!.phase, "committing");
    p.files.acquire();
    assert.throws(() => restarted.token(), /OAUTH_RESPONSE_SUPERSEDED/);
    restarted = resume();
    assert.equal(await restarted.token(), issued.access_token);
    assert.equal(p.files.read("oauth-exchange.json"), false);
    assert.equal(p.files.read("oauth-code-exchange.json"), false);
    // Once reconciliation has finished, ordinary cached reads are ownership-free.
    const reader = new PrivateFiles(p.root);
    try { assert.equal(await new TokenClient(oauth, reader, async () => assert.fail("No HTTP for cache"), () => now).token(), issued.access_token); }
    finally { reader.close(); }
    await assert.rejects(restarted.completeAuthorization(callback(fresh)), /OAUTH_CALLBACK_REFUSED/);
    assert.equal(posts, 1);
    now += 3_600_000;
    await assert.rejects(restarted.token(), /TRANSPORT_FAILED/);
    await assert.rejects(restarted.token(), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(posts, 2);
  } finally { p.files.write = write; p.cleanup(); }
});
