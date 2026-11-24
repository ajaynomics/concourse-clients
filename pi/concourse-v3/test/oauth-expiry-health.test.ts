import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "../src/auth.ts";
import type { Fetch } from "../src/http.ts";
import { Loopback } from "../src/loopback.ts";
import { login } from "../src/onboarding.ts";
import { Runtime } from "../src/runtime.ts";
import { PrivateFiles } from "../src/storage.ts";
import { config, identity, profile, response } from "./helpers.ts";

const day = 86_400_000;
const start = Date.UTC(2026, 10, 21);
const oauthConfig = (port: number): Config => ({ ...config, authorizationEndpoint: `${config.issuer}/authorize`, auth: { kind: "oauth", redirectUri: `http://127.0.0.1:${port}/callback` } });
const ctx = { sessionManager: { getSessionId: () => "synthetic-session" }, ui: { setStatus() {}, notify() {} } } as unknown as ExtensionContext;
const makeRuntime = (root: string, c: Config, fetchImpl: Fetch) => new Runtime({ fetchImpl, current: () => true, labelled: () => false, handOff() {} }, ctx, new PrivateFiles(root), c, "test");
const grant = (familySeconds?: unknown) => ({ access_token: "synthetic-access-secret", refresh_token: "synthetic-refresh-secret", token_type: "Bearer", expires_in: 600, refresh_token_expires_in: familySeconds });

async function signIn(root: string, c: Config, fetchImpl: Fetch) {
  let browser: Promise<Response> | undefined;
  assert.equal(await login({ profile: root, noOpen: true }, { fetchImpl, emit(event) {
    if (event.phase !== "authorization") return;
    const action = new URL(event.actionUrl);
    const callback = new URL(action.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: action.searchParams.get("state")!, iss: c.issuer, code: "synthetic-private-code" }).toString();
    browser = fetch(callback);
  } }), "complete");
  const result = await browser;
  assert.equal(result?.status, 200);
  await result?.text();
}

function assertHealth(files: PrivateFiles, at?: number) {
  const health = files.read<{ auth?: unknown }>("health.json")!;
  if (at === undefined) assert.equal(Object.hasOwn(health, "auth"), false);
  else assert.deepEqual(health.auth, { refreshExpiresAt: at });
  assert.doesNotMatch(JSON.stringify(health), /synthetic-(?:access|refresh)-secret|synthetic-private-code|refresh_token|expires_in/);
}

test("login seeds owned health, refresh does not move the fixed expiry later, and fresh login can replace it", async t => {
  let now = start, ttl: unknown = 30 * day / 1000;
  t.mock.method(Date, "now", () => now);
  const p = profile(), listener = new Loopback();
  await listener.bind();
  const c = oauthConfig(listener.port);
  await listener.close();
  p.files.write("config.json", c);
  let runtime: Runtime | undefined, logins = 0, refreshes = 0, identityLag = 1234;
  const fetchImpl: Fetch = async (input, init) => {
    if (String(input) === `${c.origin}/api/identity`) { now += identityLag; identityLag = 0; return response(identity); }
    assert.equal(String(input), c.tokenEndpoint);
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") === "authorization_code") logins++;
    else { assert.equal(form.get("grant_type"), "refresh_token"); refreshes++; }
    return response(grant(ttl));
  };
  try {
    await signIn(p.root, c, fetchImpl);
    assert.equal(p.files.read("health.json"), undefined, "CLI login does not claim a running Pi generation");
    runtime = makeRuntime(p.root, c, fetchImpl);
    await runtime.client.identity();
    assertHealth(p.files, start + 30 * day);
    assert.equal(logins, 1); assert.equal(refreshes, 0);

    now = start + 25 * day;
    ttl = 5 * day / 1000 + 1; // A second of response/clock drift must not postpone the warning.
    await runtime.client.identity();
    assertHealth(p.files, start + 30 * day);
    assert.equal(refreshes, 1);
    now += 11 * 60_000;
    ttl = "synthetic-misformatted-field";
    await runtime.client.identity();
    assertHealth(p.files, start + 30 * day);
    assert.equal(refreshes, 2);
    await runtime.stop(); runtime = undefined;

    ttl = 30 * day / 1000;
    await signIn(p.root, c, fetchImpl);
    runtime = makeRuntime(p.root, c, fetchImpl);
    await runtime.client.identity();
    assertHealth(p.files, now + 30 * day);
    await runtime.stop(); runtime = undefined;

    ttl = undefined;
    await signIn(p.root, c, fetchImpl);
    runtime = makeRuntime(p.root, c, fetchImpl);
    await runtime.client.identity();
    assertHealth(p.files);
    assert.equal(logins, 3);
  } finally { await runtime?.stop(); p.cleanup(); }
});

test("an older profile stays unknown until a valid refresh reports its family expiry", async t => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const p = profile(), c = oauthConfig(12345);
  p.files.write("tokens.json", { access: "synthetic-access-secret", refresh: "synthetic-refresh-secret", expires: now + 600_000, resource: c.origin, clientId: c.oauthClientId, issuer: c.issuer });
  let ttl: unknown, refreshes = 0;
  const runtime = makeRuntime(p.root, c, async (input, init) => {
    if (String(input) === `${c.origin}/api/identity`) return response(identity);
    assert.equal(String(input), c.tokenEndpoint);
    assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
    refreshes++;
    return response(grant(ttl));
  });
  try {
    await runtime.client.identity(); assertHealth(p.files);
    for (const invalid of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      ttl = invalid; now += 11 * 60_000;
      await runtime.client.identity(); assertHealth(p.files);
    }
    ttl = 0; now += 11 * 60_000; // The issuer can round less than a second remaining down to zero.
    await runtime.client.identity(); assertHealth(p.files, now);
    assert.equal(refreshes, 6);
  } finally { await runtime.stop(); p.cleanup(); }
});

test("machine credentials never expose a refresh-family expiry", async () => {
  const p = profile();
  const runtime = makeRuntime(p.root, config, async input => {
    if (String(input) === `${config.origin}/api/identity`) return response(identity);
    assert.equal(String(input), config.tokenEndpoint);
    return response({ access_token: "synthetic-access-secret", token_type: "Bearer", expires_in: 600, refresh_token_expires_in: 30 * day / 1000 });
  });
  try { await runtime.client.identity(); assertHealth(p.files); }
  finally { await runtime.stop(); p.cleanup(); }
});
