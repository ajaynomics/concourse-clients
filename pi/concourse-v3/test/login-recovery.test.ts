import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { main, parseArgs } from "../cli.ts";
import { TokenClient, type Config } from "../src/auth.ts";
import { login } from "../src/onboarding.ts";
import { Loopback } from "../src/loopback.ts";
import { config, identity, profile, response } from "./helpers.ts";
import type { Fetch } from "../src/http.ts";

const noProcess = async () => { throw new Error("No child processes in recovery tests"); };
async function fixture() {
  const p = profile(), listener = new Loopback();
  await listener.bind(); const port = listener.port; await listener.close();
  const c: Config = { ...config, authorizationEndpoint: `${config.issuer}/authorize`, auth: { kind: "oauth", redirectUri: `http://127.0.0.1:${port}/callback` } };
  const oldTokens = { access: "synthetic-old-access", refresh: "synthetic-old-refresh", expires: 1, resource: c.origin, clientId: c.oauthClientId, issuer: c.issuer };
  p.files.write("config.json", c); p.files.write("tokens.json", oldTokens); p.files.write("ledger.json", { preserved: "synthetic-ledger" });
  const snapshot = () => ["config.json", "tokens.json", "ledger.json"].map(name => readFileSync(join(p.root, name), "utf8"));
  const before = snapshot();
  const release = p.files.acquire();
  const oldState = new URL(new TokenClient(c, p.files).authorizationUrl()).searchParams.get("state");
  // Reproduce a lost rotating refresh with synthetic transport, not a fabricated marker.
  let refreshes = 0;
  const lost: Fetch = async (_input, init) => { assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token"); refreshes++; throw new Error("synthetic-private-network-detail"); };
  await assert.rejects(new TokenClient(c, p.files, lost).token(), /TRANSPORT_FAILED/);
  assert.equal(refreshes, 1); assert.equal(p.files.read("oauth-exchange.json"), true);
  release(); // login() owns its own consumer lock.
  const assertPreserved = () => { assert.deepEqual(snapshot(), before); assert.equal(p.files.read("oauth-exchange.json"), true); };
  const assertReleased = async () => { const release = p.files.acquire(); release(); const probe = new Loopback(); try { await probe.bind(port); } finally { await probe.close(); } };
  return { ...p, c, oldState, before, snapshot, assertPreserved, assertReleased };
}
function callback(action: string, denied = false): string {
  const a = new URL(action), url = new URL(a.searchParams.get("redirect_uri")!);
  url.searchParams.set("state", a.searchParams.get("state")!); url.searchParams.set("iss", config.issuer);
  if (denied) { url.searchParams.set("error", "access_denied"); url.searchParams.set("error_description", "synthetic-private-denial"); }
  else url.searchParams.set("code", "synthetic-private-code");
  return url.href;
}

test("actual CLI recovers uncertain refresh via fresh S256 once-only code and exact saved identity, without refresh/registration/card writes", async () => {
  const f = await fixture();
  try {
    const output: string[] = [], calls: string[] = []; let action = "", browser: Promise<number> | undefined;
    const fetchImpl: Fetch = async (input, init) => {
      const url = String(input); calls.push(url);
      if (url === f.c.tokenEndpoint) {
        const form = new URLSearchParams(String(init?.body)), a = new URL(action);
        assert.equal(init?.method, "POST"); assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(form.get("client_id"), f.c.oauthClientId); assert.equal(form.get("resource"), f.c.origin);
        assert.equal(form.get("redirect_uri"), a.searchParams.get("redirect_uri"));
        assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), a.searchParams.get("code_challenge"));
        assert.equal((await fetch(callback(action))).status, 400, "duplicate callback cannot POST again");
        return response({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", token_type: "Bearer", expires_in: 3600 });
      }
      assert.equal(url, `${f.c.origin}/api/identity`); assert.equal(init?.method, "GET");
      assert.equal(new Headers(init?.headers).get("Concourse-Organization"), calls.filter(url => url === `${f.c.origin}/api/identity`).length === 1 ? null : f.c.organization);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-new-access");
      f.assertPreserved(); // Identity acceptance precedes token replacement.
      return response(identity);
    };
    const result = await main(["login", "--profile", f.root, "--no-open", "--json"], noProcess, line => {
      output.push(line); const event = JSON.parse(line);
      if (event.phase === "authorization") {
        action = event.actionUrl; const a = new URL(action);
        assert.notEqual(a.searchParams.get("state"), f.oldState); assert.equal(a.searchParams.get("code_challenge_method"), "S256");
        assert.equal(a.searchParams.get("redirect_uri"), (f.c.auth as { redirectUri: string }).redirectUri);
        browser = (async () => {
          for (const key of ["state", "iss", "path", "host"]) {
            const invalid = new URL(callback(action));
            if (key === "path") invalid.pathname = "/wrong";
            else if (key !== "host") invalid.searchParams.set(key, "wrong");
            const status = await new Promise<number | undefined>((resolve, reject) => {
              get(invalid, key === "host" ? { headers: { host: "localhost" } } : {}, r => { r.resume(); r.on("end", () => resolve(r.statusCode)); }).on("error", reject);
            });
            assert.equal(status, 400);
          }
          assert.equal(calls.length, 0, "invalid callbacks never reach token POST");
          return (await fetch(callback(action))).status;
        })();
      }
    }, { fetchImpl, open: async () => { assert.fail("--no-open must not launch browser"); } });
    assert.equal(result, 0); assert.equal(await browser, 200);
    assert.deepEqual(calls, [f.c.tokenEndpoint, `${f.c.origin}/api/identity`, `${f.c.origin}/api/identity`]);
    assert.deepEqual(output.map(line => JSON.parse(line).phase), ["authorization", "complete"]);
    assert.equal(f.files.read("oauth-exchange.json"), false);
    assert.equal(f.files.read<{ access: string }>("tokens.json")!.access, "synthetic-new-access");
    const saved = f.files.read<{ codeCommit: { identity: unknown } }>("tokens.json")!;
    const { network_agent: _network, ...verified } = identity;
    assert.deepEqual(saved.codeCommit.identity, verified);
    assert.equal(f.files.read("oauth-code-exchange.json"), false);
    assert.equal(f.snapshot()[0], f.before[0]); assert.equal(f.snapshot()[2], f.before[2]);
    assert.doesNotMatch(output.join("\n"), /synthetic-(?:new|old)-(?:access|refresh)|synthetic-private-code|code_verifier/);
    await f.assertReleased();
  } finally { f.cleanup(); }
});

for (const mismatch of ["owner", "organization", "handle", "oauth_client_id", "release_line", "failed"] as const) {
  test(`CLI refuses ${mismatch} identity without replacing old credentials or clearing uncertainty`, async () => {
    const f = await fixture();
    try {
      const output: string[] = []; let browser: Promise<number> | undefined, posts = 0;
      const fetchImpl: Fetch = async (input, init) => {
        if (String(input) === f.c.tokenEndpoint) { posts++; assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "authorization_code"); return response({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", token_type: "Bearer", expires_in: 3600 }); }
        assert.equal(String(input), `${f.c.origin}/api/identity`);
        return mismatch === "failed" ? response({ private: "synthetic-private-error" }, 500) : response({ ...identity, [mismatch]: mismatch === "release_line" ? 2 : "different" });
      };
      assert.equal(await main(["login", "--profile", f.root, "--no-open", "--json"], noProcess, line => {
        output.push(line); const event = JSON.parse(line); if (event.phase === "authorization") browser = fetch(callback(event.actionUrl)).then(r => r.status);
      }, { fetchImpl }), 1);
      assert.equal(await browser, 400); assert.equal(posts, 1); f.assertPreserved(); await f.assertReleased();
      assert.equal(new TokenClient(f.c, f.files).exchangeState(), "fenced");
      assert.equal(f.files.read<{ phase: string }>("oauth-code-exchange.json")!.phase, "dispatch-uncertain");
      assert.doesNotMatch(output.join("\n"), /synthetic-private|synthetic-new/);
      assert.equal(JSON.parse(output.at(-1)!).error, mismatch === "failed" ? "HTTP_REFUSED_500" : "V3_IDENTITY_REFUSED");
    } finally { f.cleanup(); }
  });
}

for (const mode of ["denied", "cancelled", "timed-out", "open-failed"] as const) {
  test(`${mode} fresh login releases port/lock and retains old fence`, async () => {
    const f = await fixture();
    try {
      const controller = new AbortController(); const output: string[] = []; let browser: Promise<number> | undefined;
      const args = ["login", "--profile", f.root, "--json", ...(mode === "open-failed" ? [] : ["--no-open"])];
      assert.equal(await main(args, noProcess, line => {
        output.push(line); const event = JSON.parse(line);
        if (event.phase === "authorization") {
          if (mode === "denied") browser = fetch(callback(event.actionUrl, true)).then(r => r.status);
          if (mode === "cancelled") controller.abort();
        }
      }, { signal: controller.signal, timeoutMs: mode === "timed-out" ? 50 : 5000, fetchImpl: async () => { assert.fail("No token or identity HTTP expected"); }, open: async () => { throw new Error("synthetic-private-open-error"); } }), 1);
      if (browser) assert.equal(await browser, 200);
      f.assertPreserved(); await f.assertReleased();
      assert.equal(JSON.parse(output.at(-1)!).error, { denied: "AUTHORIZATION_DENIED", cancelled: "SETUP_CANCELLED", "timed-out": "CALLBACK_TIMEOUT", "open-failed": "LOCAL_PROFILE_OR_INSTALL_REFUSED" }[mode]);
      assert.doesNotMatch(output.join("\n"), /synthetic-private/);
    } finally { f.cleanup(); }
  });
}

test("held profile, cancelled entry, machine or missing config refuse before network or authorization", async () => {
  const f = await fixture();
  try {
    let actions = 0; const deps = { fetchImpl: async () => { assert.fail("No HTTP"); }, emit: () => { actions++; } };
    const release = f.files.acquire();
    await assert.rejects(login({ profile: f.root }, deps), /already owned/); release();
    await assert.rejects(login({ profile: f.root }, { ...deps, signal: AbortSignal.abort() }), /SETUP_CANCELLED/);
    f.files.write("config.json", config); await assert.rejects(login({ profile: f.root }, deps), /NOT_OAUTH/);
    f.files.write("config.json", null); await assert.rejects(login({ profile: f.root }, deps), /INVALID_V3_CONFIG/);
    assert.equal(actions, 0); await f.assertReleased();
  } finally { f.cleanup(); }
});

test("login CLI strictly rejects every identity/client/setup override and redacts invalid input", async () => {
  assert.deepEqual(parseArgs(["login", "--profile", "/absolute/concourse-v3/agent", "--no-open", "--json"]).options, { profile: "/absolute/concourse-v3/agent", noOpen: true });
  for (const flag of ["--origin", "--agent", "--oauth-client-id", "--organization", "--resume", "--callback-port", "--"]) {
    const output: string[] = [];
    assert.equal(await main(["login", "--profile", "/absolute/concourse-v3/agent", "--json", flag, "synthetic-private-input"], noProcess, line => output.push(line)), 1);
    assert.equal(JSON.parse(output[0]).error, "INVALID_CLI_OPTION"); assert.doesNotMatch(output[0], /synthetic-private/);
  }
  assert.throws(() => parseArgs(["login"]), /EXPLICIT_PROFILE_REQUIRED/);
});

test("uncertain doctor CLI retains exact error and nonsecret explicit login action in human and JSON output", async () => {
  const f = await fixture();
  try {
    for (const json of [false, true]) {
      const output: string[] = [];
      assert.equal(await main(["doctor", "--profile", f.root, ...(json ? ["--json"] : [])], noProcess, line => output.push(line), { fetchImpl: async () => { assert.fail("Fenced refresh must not dispatch"); } }), 1);
      assert.match(output[0], /OAUTH_EXCHANGE_UNCERTAIN/); assert.match(output[0], /script\/concourse-v3 login/);
      assert.match(output[0], /fully configured existing OAuth profile only/);
      assert.match(output[0], /Incomplete signup drafts cannot use login/);
      if (json) { assert.equal(JSON.parse(output[0]).error, "OAUTH_EXCHANGE_UNCERTAIN"); assert.equal(JSON.parse(output[0]).uncertain, true); }
      assert.doesNotMatch(output[0], /synthetic-old|synthetic-private/);
    }
    f.assertPreserved(); await f.assertReleased();
  } finally { f.cleanup(); }
});

test("busy saved port refuses before generating fresh state and releases the profile lock", async () => {
  const f = await fixture(), occupied = new Loopback();
  try {
    await occupied.bind(Number(new URL((f.c.auth as { redirectUri: string }).redirectUri).port));
    await assert.rejects(login({ profile: f.root }, { fetchImpl: async () => { assert.fail("No HTTP"); }, emit: () => { assert.fail("No action before bind"); } }), /CALLBACK_PORT_UNAVAILABLE/);
    assert.equal(f.files.read<{ state: string }>("oauth-pending.json")!.state, f.oldState);
    f.assertPreserved(); await occupied.close(); await f.assertReleased();
  } finally { await occupied.close(); f.cleanup(); }
});

for (const boundary of ["token", "identity"] as const) {
  test(`cancellation during ${boundary} HTTP cannot accept new tokens`, async () => {
    const f = await fixture(), controller = new AbortController();
    try {
      let browser: Promise<number> | undefined; const output: string[] = [], calls: string[] = [];
      const fetchImpl: Fetch = async input => {
        calls.push(String(input));
        if (String(input) === f.c.tokenEndpoint) {
          if (boundary === "token") controller.abort();
          return response({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh", token_type: "Bearer", expires_in: 3600 });
        }
        assert.equal(String(input), `${f.c.origin}/api/identity`); controller.abort(); return response(identity);
      };
      assert.equal(await main(["login", "--profile", f.root, "--no-open", "--json"], noProcess, line => {
        output.push(line); const e = JSON.parse(line); if (e.phase === "authorization") browser = fetch(callback(e.actionUrl)).then(r => r.status);
      }, { fetchImpl, signal: controller.signal }), 1);
      assert.equal(await browser, 400); assert.equal(JSON.parse(output.at(-1)!).error, "SETUP_CANCELLED");
      assert.equal(calls.length, boundary === "token" ? 1 : 2); f.assertPreserved(); await f.assertReleased();
    } finally { f.cleanup(); }
  });
}
