import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { signup, discover, doctor, EXPECTED_ISSUER, type Draft, type SignupOptions, type SetupEvent, type SetupDependencies } from "../src/onboarding.ts";
import { TokenClient, validateConfig, type Config } from "../src/auth.ts";
import { createProfile, PrivateFiles } from "../src/storage.ts";
import { Loopback } from "../src/loopback.ts";
import { onboardingIdentity, safeFetch, SafeError, validOrganizationSlug, type Fetch } from "../src/http.ts";
import { response } from "./helpers.ts";

const origin = "https://concourse.invalid";
const access = "synthetic.access.secret", refresh = "synthetic.refresh.secret", code = "synthetic-code-secret";
const provisionedUid = "synthetic-provisioned_UID-123";
const issuerMetadata = { issuer: EXPECTED_ISSUER, authorization_endpoint: `${EXPECTED_ISSUER}/oauth/authorize`, token_endpoint: `${EXPECTED_ISSUER}/oauth/token`, registration_endpoint: `${EXPECTED_ISSUER}/oauth/register`, code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ["none"] };
const resourceMetadata = { resource: origin, authorization_servers: [EXPECTED_ISSUER] };
function callback(url: string, options: { method?: string; host?: string; path?: string } = {}): Promise<number> {
  const u = new URL(url);
  assert.equal(u.hostname, "127.0.0.1");
  return new Promise((resolve, reject) => {
    const r = request({ hostname: "127.0.0.1", port: u.port, path: options.path ?? `${u.pathname}${u.search}`, method: options.method ?? "GET", headers: { Host: options.host ?? u.host } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    r.once("error", reject); r.end();
  });
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "concourse-onboarding-")), root = join(base, "concourse-v3", "my-agent");
  const events: SetupEvent[] = [];
  const calls: { path: string; init?: RequestInit }[] = [];
  const state = { admitted: true, members: ["team"], boundOrg: "", owner: "owner", agentId: 4, handle: null as string | null, client: provisionedUid, exchangeLost: false, cardLost: false, cardApplied: true, cardRefused: false, identityChange: false, pauseOAuth: false };
  const fetchImpl: Fetch = async (input, init) => {
    const u = new URL(String(input)); calls.push({ path: u.pathname, init });
    assert.equal(init?.redirect, "error"); assert.equal(u.protocol, "https:");
    assert.ok([origin, EXPECTED_ISSUER].includes(u.origin), "fake never contacts unknown host");
    if (u.pathname.startsWith("/.well-known/")) { assert.equal(new Headers(init?.headers).has("authorization"), false); return response(u.origin === origin ? resourceMetadata : issuerMetadata); }
    if (u.pathname === "/oauth/register") assert.fail("ordinary DCR must never be called for provisioned signup or resume");
    if (u.pathname === "/oauth/token") {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("client_id"), state.client); assert.equal(form.get("resource"), origin); assert.equal(form.get("scope"), "concourse");
      assert.equal(new Headers(init?.headers).has("authorization"), false, "public-native token exchange has no client secret");
      assert.equal(form.has("client_secret"), false);
      if (form.get("grant_type") === "authorization_code") { assert.equal(form.get("redirect_uri"), read<Draft>("onboarding.json")!.redirectUri); assert.equal(form.get("code_verifier")?.length, 43); }
      if (state.exchangeLost) throw new Error("synthetic lost token response " + access);
      return response({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: "concourse" });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${access}`);
    const selected = new Headers(init?.headers).get("Concourse-Organization");
    if (u.pathname === "/api/identity") {
      if (!state.admitted) return response({ error: "not_a_member", message: "Web admission needed" }, 403);
      if (state.boundOrg && selected && selected !== state.boundOrg) return response({ error: "organization_conflict", message: "Bound elsewhere", organizations: state.members.map(slug => ({ slug, name: slug })) }, 409);
      if ((!selected && state.members.length > 1) || (selected && !state.members.includes(selected))) return response({ error: selected ? "organization_invalid" : "organization_required", message: "Choose membership", organizations: state.members.map(slug => ({ slug, name: slug })) }, 409);
      state.boundOrg ||= selected ?? state.members[0];
      return response({ release_line: 3, network_agent: "concourse/network-1", owner: state.owner, agent_id: state.agentId, handle: state.handle, organization: state.boundOrg, oauth_client_id: state.client });
    }
    if (u.pathname === "/api/card") {
      assert.equal(init?.method, "PATCH"); assert.equal(selected, state.boundOrg);
      assert.deepEqual(JSON.parse(String(init?.body)), { handle: "my-agent", name: "my-agent", harness: "pi" });
      if (state.cardRefused) return response({ error: "invalid_params" }, 422);
      if (state.cardApplied) state.handle = "my-agent";
      if (state.identityChange) state.owner = "substituted";
      if (state.cardLost) throw new Error("synthetic lost card response");
      return response({ name: "owner/my-agent" });
    }
    throw new Error("Unexpected fake route " + u.pathname);
  };
  const open = async (url: string) => {
    const action = new URL(url);
    if (action.pathname === "/oauth/authorize") {
      assert.equal(action.origin, EXPECTED_ISSUER); assert.equal(action.searchParams.get("code_challenge_method"), "S256");
      assert.equal(action.searchParams.get("client_id"), state.client); assert.equal(action.searchParams.get("resource"), origin);
      assert.equal(action.searchParams.get("scope"), "concourse"); assert.equal(action.searchParams.get("response_type"), "code");
      const target = new URL(action.searchParams.get("redirect_uri")!);
      const draft = read<Draft>("onboarding.json")!;
      assert.equal(draft.version, 2); assert.equal(draft.registration, "provisioned"); assert.equal(draft.oauthClientId, state.client);
      assert.equal(target.href, draft.redirectUri);
      if (state.pauseOAuth) return;
      assert.equal(await callback(target.href + "?state=not-pending"), 400, "ephemeral listener is already bound before authorization");
      target.search = new URLSearchParams({ code, state: action.searchParams.get("state")!, iss: EXPECTED_ISSUER }).toString();
      assert.equal(await callback(target.href), 200);
    } else {
      assert.equal(action.origin, origin); assert.equal(action.pathname, "/developer/setup");
      state.admitted = true;
      assert.equal(await callback(`http://127.0.0.1:${action.searchParams.get("port")}/setup-complete?${new URLSearchParams({ state: action.searchParams.get("state")!, organization: state.members[0] })}`), 200);
    }
  };
  const deps: SetupDependencies = { fetchImpl, open, emit: e => events.push(e), timeoutMs: 1000 };
  function read<T>(name: string): T | undefined { const files = new PrivateFiles(root); try { return files.read<T>(name); } finally { files.close(); } }
  return { base, root, state, calls, events, fetchImpl, open, deps, read, options: { profile: root, origin, agent: "my-agent", oauthClientId: provisionedUid }, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("fresh organization signup and doctor produce a configuration the runtime accepts", async () => {
  const { openProfile } = await import("../src/runtime.ts");
  const f = fixture(); f.state.admitted = false; f.state.members = ["example-team"];
  try {
    assert.equal(await signup(f.options, f.deps), "complete");
    assert.deepEqual(f.events.map(e => e.phase), ["authorization", "web_admission", "complete"]);
    assert.equal((await doctor(f.root, f.fetchImpl)).identity.organization, "example-team");
    const opened = openProfile(join(f.root, "config.json"));
    try {
      assert.equal(opened.config.organization, "example-team");
      assert.equal(opened.config.oauthClientId, f.state.client);
      assert.equal(opened.config.origin, origin);
    } finally { opened.files.close(); }
    assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0);
  } finally { f.cleanup(); }
});

test("signup: provisioned public UID -> PKCE without DCR -> web admission hint -> authenticated identity -> naming -> strict config; no secrets in output", async () => {
  const f = fixture(); f.state.admitted = false;
  try {
    assert.equal(await signup(f.options, f.deps), "complete");
    assert.deepEqual(f.events.map(e => e.phase), ["authorization", "web_admission", "complete"]);
    const c = f.read<Config>("config.json")!; assert.equal(validateConfig(c).owner, "owner"); assert.equal(c.organization, "team"); assert.equal(c.agent, "my-agent");
    assert.deepEqual(f.read<Draft>("onboarding.json")?.identity?.handle, null, "draft stores real unnamed state, no fake agent identity");
    const draft = f.read<Draft>("onboarding.json")!; assert.equal(draft.version, 2); assert.equal(draft.registration, "provisioned"); assert.equal(draft.oauthClientId, provisionedUid);
    assert.equal(draft.metadata?.registrationEndpoint, issuerMetadata.registration_endpoint, "trusted metadata remains cached, not called");
    assert.equal(c.oauthClientId, provisionedUid); assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0);
    const oauth = f.events[0], bridge = f.events[1]; assert.ok("actionUrl" in oauth && "actionUrl" in bridge);
    assert.notEqual(new URL(oauth.actionUrl).searchParams.get("state"), new URL(bridge.actionUrl).searchParams.get("state"));
    assert.ok(f.calls.filter(c => c.path === "/api/identity").length >= 3);
    assert.equal(statSync(f.root).mode & 0o777, 0o700);
    for (const name of ["config.json", "tokens.json", "onboarding.json", "oauth-pending.json", "consumer.json"]) assert.equal(statSync(join(f.root, name)).mode & 0o777, 0o600);
    const output = JSON.stringify(f.events); for (const secret of [access, refresh, code, f.read<{ verifier: string }>("oauth-pending.json")?.verifier ?? "not-present-verifier"]) assert.equal(output.includes(secret), false);
    const pathsBefore = f.calls.length; assert.equal((await doctor(f.root, f.fetchImpl)).phase, "healthy"); assert.deepEqual(f.calls.slice(pathsBefore).map(c => c.path), ["/api/identity"]);
    const saved = readFileSync(join(f.root, "config.json"), "utf8");
    await assert.rejects(signup({ profile: f.root, resume: true }, f.deps), /PROFILE_ALREADY_CONFIGURED/);
    assert.equal(readFileSync(join(f.root, "config.json"), "utf8"), saved);
  } finally { f.cleanup(); }
});
test("multiple memberships: noninteractive choice, same provisioned UID/tokens on explicit resume, never first-org auto-selection", async () => {
  const f = fixture(); f.state.members = ["first", "chosen"];
  try {
    const callbacks: Promise<void>[] = [];
    const emit = (e: SetupEvent) => { f.events.push(e); if (e.phase === "authorization") callbacks.push(f.open(e.actionUrl)); };
    assert.equal(await signup({ ...f.options, noOpen: true }, { ...f.deps, emit }), "organization_choice"); await Promise.all(callbacks);
    assert.equal(f.state.boundOrg, ""); assert.equal(f.read("config.json"), undefined);
    const before = f.read<Draft>("onboarding.json")!;
    assert.equal(await signup({ profile: f.root, resume: true, organization: "chosen", noOpen: true }, f.deps), "complete");
    assert.equal(f.read<Config>("config.json")!.organization, "chosen");
    assert.equal(f.read<Draft>("onboarding.json")!.oauthClientId, before.oauthClientId);
    assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0); assert.equal(f.calls.filter(c => c.path === "/oauth/token").length, 1);
  } finally { f.cleanup(); }
});
test("explicit organization bypasses web bridge for existing membership; bound client conflict refuses and never re-registers", async () => {
  const f = fixture(); f.state.members = ["first", "chosen"]; f.state.cardApplied = false; f.state.cardLost = true;
  try {
    await assert.rejects(signup({ ...f.options, organization: "chosen" }, f.deps), /CARD_WRITE_UNCONFIRMED/);
    assert.equal(f.events.some(e => e.phase === "web_admission"), false);
    const count = f.calls.length;
    await assert.rejects(signup({ profile: f.root, resume: true, organization: "first" }, f.deps), /ORGANIZATION_CONFLICT/);
    assert.deepEqual(f.calls.slice(count).map(c => c.path), ["/api/identity"]);
    assert.equal(f.read("config.json"), undefined);
  } finally { f.cleanup(); }
});
test("metadata refuses resource/issuer substitutions, weak PKCE, absent iss and endpoint tunneling without sending any credentials", async () => {
  const cases = [
    { resource: { ...resourceMetadata, resource: "https://wrong.invalid" } },
    { resource: { ...resourceMetadata, authorization_servers: ["https://attacker.invalid"] } },
    { issuer: { ...issuerMetadata, issuer: "https://attacker.invalid" } },
    { issuer: { ...issuerMetadata, code_challenge_methods_supported: ["plain"] } },
    { issuer: { ...issuerMetadata, authorization_response_iss_parameter_supported: false } },
    { issuer: { ...issuerMetadata, token_endpoint: "https://attacker.invalid/token" } },
    { issuer: { ...issuerMetadata, registration_endpoint: "http://127.0.0.1/register" } },
    { issuer: { ...issuerMetadata, authorization_endpoint: `${EXPECTED_ISSUER}/oauth/authorize?redirect=evil` } },
    { issuer: { ...issuerMetadata, token_endpoint_auth_methods_supported: ["client_secret_basic"] } },
  ];
  for (const c of cases) {
    const calls: string[] = [];
    await assert.rejects(discover(origin, async (url, init) => { calls.push(String(url)); assert.equal(new Headers(init?.headers).has("authorization"), false); return response(String(url).startsWith(origin) ? c.resource ?? resourceMetadata : c.issuer ?? issuerMetadata); }));
    assert.ok(calls.length <= 2); assert.ok(calls.every(u => u.startsWith(origin) || u.startsWith(EXPECTED_ISSUER)));
  }
  await assert.rejects(discover(origin, async () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } })), /REDIRECT_REFUSED/);
});
test("metadata failure remains resumable on the same callback port without registration", async () => {
  const f = fixture();
  try {
    await assert.rejects(signup(f.options, { ...f.deps, fetchImpl: async () => response({ resource: "wrong" }) }), /RESOURCE_METADATA_REFUSED/);
    const first = f.read<Draft>("onboarding.json")!; assert.equal(first.version, 2); assert.equal(first.registration, "provisioned"); assert.equal(first.oauthClientId, provisionedUid); assert.equal(first.metadata, undefined);
    assert.equal(f.read("oauth-pending.json"), undefined); assert.equal(f.events.length, 0);
    await signup({ profile: f.root, resume: true }, f.deps);
    assert.equal(f.read<Draft>("onboarding.json")!.redirectUri, first.redirectUri);
    assert.equal(f.read<Draft>("onboarding.json")!.oauthClientId, first.oauthClientId);
    assert.equal(f.read<Config>("config.json")!.oauthClientId, provisionedUid);
    assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0);
  } finally { f.cleanup(); }
});
test("strict loopback callback method/host/path/query/state/iss; invalid callbacks don't consume pending and duplicates can't exchange twice", async () => {
  const f = fixture();
  try {
    const open = async (url: string) => {
      const action = new URL(url), target = new URL(action.searchParams.get("redirect_uri")!);
      const valid = new URLSearchParams({ code, state: action.searchParams.get("state")!, iss: EXPECTED_ISSUER }); target.search = valid.toString();
      const invalids = [
        { method: "POST" }, { host: "attacker.invalid" }, { host: `localhost:${target.port}` },
        { path: `/elsewhere?${valid}` }, { path: `/callback?${valid}&code=duplicate` }, { path: `/callback?${valid}&extra=1` },
        { path: `/callback?${valid.toString().replace(action.searchParams.get("state")!, "wrong")}` },
        { path: `/callback?${valid.toString().replace(encodeURIComponent(EXPECTED_ISSUER), encodeURIComponent("https://wrong.invalid"))}` },
        { path: `/callback?${new URLSearchParams({ code, state: action.searchParams.get("state")! })}` },
      ];
      for (const invalid of invalids) assert.equal(await callback(target.href, invalid), 400);
      assert.equal(f.calls.filter(c => c.path === "/oauth/token").length, 0);
      assert.equal(await callback(target.href), 200); assert.equal(await callback(target.href), 400);
    };
    await signup(f.options, { ...f.deps, open }); assert.equal(f.calls.filter(c => c.path === "/oauth/token").length, 1);
  } finally { f.cleanup(); }
});
test("timeout cleans listener, saves provisioned UID/PKCE; busy exact resume port fails without replacing client", async () => {
  const f = fixture(); f.state.pauseOAuth = true;
  const busy = new Loopback();
  try {
    await assert.rejects(signup(f.options, { ...f.deps, timeoutMs: 20 }), /CALLBACK_TIMEOUT/);
    const draft = f.read<Draft>("onboarding.json")!, firstUrl = (f.events[0] as { actionUrl: string }).actionUrl;
    await assert.rejects(callback(draft.redirectUri), /ECONNREFUSED/);
    await busy.bind(Number(new URL(draft.redirectUri).port)); const count = f.calls.length;
    await assert.rejects(signup({ profile: f.root, resume: true }, f.deps), /CALLBACK_PORT_UNAVAILABLE/);
    assert.equal(f.calls.length, count); assert.equal(f.read<Draft>("onboarding.json")!.oauthClientId, draft.oauthClientId);
    await busy.close(); f.state.pauseOAuth = false; await signup({ profile: f.root, resume: true }, f.deps);
    assert.equal((f.events[1] as { actionUrl: string }).actionUrl, firstUrl, "fresh pending OAuth resumes same state/verifier");
    assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0);
    assert.equal(f.read<Draft>("onboarding.json")!.redirectUri, draft.redirectUri);
    assert.equal(f.read<Draft>("onboarding.json")!.oauthClientId, provisionedUid);
  } finally { await busy.close(); f.cleanup(); }
});
test("cancel aborts listener wait and shares runtime kernel lock until cleanup", async () => {
  const f = fixture(), controller = new AbortController();
  try {
    const open = async () => {
      const second = new PrivateFiles(f.root);
      try { assert.throws(() => second.acquire(), /already owned/); } finally { second.close(); }
      controller.abort();
    };
    await assert.rejects(signup(f.options, { ...f.deps, open, signal: controller.signal }), /SETUP_CANCELLED/);
    const files = new PrivateFiles(f.root); const release = files.acquire(); release(); files.close();
    assert.equal(f.calls.filter(c => c.path === "/oauth/token").length, 0);
  } finally { f.cleanup(); }
});
test("malformed explicit provisioned UID is refused before profile creation, metadata or browser output", async () => {
  for (const oauthClientId of [null, 123, "", "bad.client", "https://client.invalid", "with space", "bad/client", "é", "a\n", "a".repeat(2049)]) {
    const f = fixture();
    try {
      await assert.rejects(signup({ ...f.options, oauthClientId: oauthClientId as SignupOptions["oauthClientId"] }, f.deps), (e: unknown) => e instanceof SafeError && e.code === "PROVISIONED_CLIENT_ID_REQUIRED" && !e.uncertain && !e.message.includes("bad.client"));
      assert.equal(existsSync(f.root), false); assert.equal(f.calls.length, 0); assert.deepEqual(f.events, []);
    } finally { f.cleanup(); }
  }
});
test("provisioned UID is bounded opaque input, not a URL or an agent handle", async () => {
  for (const oauthClientId of ["A", "_", "-", "Ab_9-", "A".repeat(2048)]) {
    const f = fixture();
    try {
      await assert.rejects(signup({ ...f.options, oauthClientId }, { ...f.deps, fetchImpl: async () => response({ resource: "wrong" }) }), /RESOURCE_METADATA_REFUSED/);
      assert.equal(f.read<Draft>("onboarding.json")!.oauthClientId, oauthClientId);
      assert.equal(f.read<Draft>("onboarding.json")!.registration, "provisioned");
      assert.equal(f.read("oauth-pending.json"), undefined); assert.deepEqual(f.events, []);
    } finally { f.cleanup(); }
  }
});
test("programmatic resume rejects every supplied client override, including the same UID, without touching the saved intent", async () => {
  const f = fixture(); f.state.pauseOAuth = true;
  try {
    await assert.rejects(signup(f.options, { ...f.deps, timeoutMs: 20 }), /CALLBACK_TIMEOUT/);
    const names = ["onboarding.json", "oauth-pending.json"], saved = names.map(name => readFileSync(join(f.root, name)));
    const count = f.calls.length, events = f.events.length;
    for (const oauthClientId of [provisionedUid, "other-UID", "", "synthetic.private.input"]) {
      await assert.rejects(signup({ profile: f.root, resume: true, oauthClientId }, f.deps), (e: unknown) => e instanceof SafeError && e.code === "RESUME_CLIENT_OVERRIDE_REFUSED" && !e.uncertain && !e.message.includes("synthetic.private.input"));
      names.forEach((name, i) => assert.deepEqual(readFileSync(join(f.root, name)), saved[i]));
      assert.equal(f.calls.length, count); assert.equal(f.events.length, events);
    }
    assert.equal(f.read("tokens.json"), undefined); assert.equal(f.read("oauth-exchange.json"), undefined);
  } finally { f.cleanup(); }
});
test("all legacy v1 DCR drafts are fenced before network/intent changes; uncertainty and original bytes survive", async () => {
  for (const registration of ["unattempted", "registered", "uncertain"]) for (const withMetadata of [false, true]) {
    const f = fixture(); createProfile(f.root); const files = new PrivateFiles(f.root);
    const metadata = { issuer: EXPECTED_ISSUER, authorizationEndpoint: issuerMetadata.authorization_endpoint, tokenEndpoint: issuerMetadata.token_endpoint, registrationEndpoint: issuerMetadata.registration_endpoint };
    try {
      files.write("onboarding.json", { version: 1, origin, agent: "my-agent", redirectUri: "http://127.0.0.1:4444/callback", registration, ...(withMetadata ? { metadata } : {}), ...(registration === "registered" ? { oauthClientId: "synthetic-legacy-client" } : {}), card: "unattempted" });
      files.write("oauth-pending.json", { state: "s".repeat(43), verifier: "v".repeat(43), expires: Date.now() + 300_000, resource: origin, clientId: "synthetic-legacy-client", issuer: EXPECTED_ISSUER, redirectUri: "http://127.0.0.1:4444/callback" });
      files.write("tokens.json", { access, refresh, expires: Date.now() + 300_000, resource: origin, clientId: "synthetic-legacy-client", issuer: EXPECTED_ISSUER });
      files.write("oauth-exchange.json", true); files.close();
      const names = ["onboarding.json", "oauth-pending.json", "tokens.json", "oauth-exchange.json"], saved = names.map(name => readFileSync(join(f.root, name)));
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(signup({ profile: f.root, resume: true }, f.deps), (e: unknown) => e instanceof SafeError && e.code === (registration === "uncertain" ? "REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER" : "LEGACY_DCR_DRAFT_REQUIRES_FRESH_PROFILE") && e.uncertain === (registration === "uncertain"));
        names.forEach((name, i) => assert.deepEqual(readFileSync(join(f.root, name)), saved[i]));
      }
      assert.equal(f.calls.length, 0); assert.deepEqual(f.events, []); assert.equal(f.read("config.json"), undefined);
    } finally { files.close(); f.cleanup(); }
  }
});
test("uncertain code exchange cannot regenerate authorization or re-register on resume", async () => {
  const f = fixture(); f.state.exchangeLost = true;
  try {
    await assert.rejects(signup(f.options, { ...f.deps, open: async url => { const u = new URL(url), target = new URL(u.searchParams.get("redirect_uri")!); target.search = new URLSearchParams({ code, state: u.searchParams.get("state")!, iss: EXPECTED_ISSUER }).toString(); assert.equal(await callback(target.href), 400); } }), /TRANSPORT_FAILED/);
    assert.equal(f.read("oauth-exchange.json"), undefined);
    assert.equal(f.read<{ phase: string }>("oauth-code-exchange.json")!.phase, "dispatch-uncertain");
    await assert.rejects(signup({ profile: f.root, resume: true }, f.deps), /OAUTH_EXCHANGE_UNCERTAIN/);
    assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0); assert.equal(f.calls.filter(c => c.path === "/oauth/token").length, 1);
    assert.equal(JSON.stringify(f.events).includes(access), false);
  } finally { f.cleanup(); }
});
test("unknown card PATCH reconciles authoritative identity; absent result stays fenced across resume", async () => {
  for (const applied of [true, false]) {
    const f = fixture(); f.state.cardLost = true; f.state.cardApplied = applied;
    try {
      if (applied) assert.equal(await signup(f.options, f.deps), "complete");
      else {
        await assert.rejects(signup(f.options, f.deps), /CARD_WRITE_UNCONFIRMED/);
        await assert.rejects(signup({ profile: f.root, resume: true }, f.deps), /CARD_WRITE_UNCONFIRMED/);
        assert.equal(f.read("config.json"), undefined);
        f.state.handle = "my-agent"; assert.equal(await signup({ profile: f.root, resume: true }, f.deps), "complete");
      }
      assert.equal(f.calls.filter(c => c.path === "/api/card").length, 1);
      assert.equal(f.read<Config>("config.json")!.agent, "my-agent");
    } finally { f.cleanup(); }
  }
});
test("immutable handle mismatch, client/owner/agent substitution and known card refusal cannot finalize or rename/rebind", async () => {
  for (const kind of ["handle", "client", "owner", "agent", "refused"]) {
    const f = fixture();
    if (kind === "handle") f.state.handle = "different-agent";
    if (kind === "owner") f.state.identityChange = true;
    if (kind === "refused") { f.state.handle = "my-agent"; f.state.cardRefused = true; }
    const transport: Fetch = async (u, init) => {
      const r = await f.fetchImpl(u, init);
      if (String(u).endsWith("/api/identity") && r.ok && (kind === "client" || kind === "agent")) {
        const b = await r.json(); if (kind === "client") b.oauth_client_id = "other-client"; else if (f.state.handle) b.agent_id = 5; return response(b);
      }
      return r;
    };
    try {
      await assert.rejects(signup(f.options, { ...f.deps, fetchImpl: transport })); assert.equal(f.read("config.json"), undefined);
      if (["handle", "client"].includes(kind)) assert.equal(f.calls.filter(c => c.path === "/api/card").length, 0);
      assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0);
    } finally { f.cleanup(); }
  }
});
test("web hint is untrusted: browser membership cannot authorize terminal token; reject account/org disagreement", async () => {
  const f = fixture(); f.state.admitted = false;
  try {
    const open = async (url: string) => {
      if (new URL(url).pathname === "/oauth/authorize") return f.open(url);
      const u = new URL(url); assert.equal(await callback(`http://127.0.0.1:${u.searchParams.get("port")}/setup-complete?${new URLSearchParams({ state: u.searchParams.get("state")!, organization: "browser-only" })}`), 200);
    };
    await assert.rejects(signup(f.options, { ...f.deps, open }), /WEB_ADMISSION_REQUIRED/);
    assert.equal(f.calls.filter(c => c.path === "/api/card").length, 0); assert.equal(f.read("config.json"), undefined);
  } finally { f.cleanup(); }
});
test("onboarding errors are narrow, bounded and schema validated; runtime errors remain discarded", async () => {
  const choices = { error: "organization_required", message: "Choose", organizations: [{ slug: "team", name: "Team" }] };
  const result = await onboardingIdentity(origin, access, undefined, async () => response(choices, 409)); assert.equal(result.status, 409);
  await assert.rejects(safeFetch(origin, async () => response(choices, 409))(`${origin}/api/identity`), /HTTP_REFUSED/);
  for (const b of ["x".repeat(33000), { error: "arbitrary-error" }, { ...choices, organizations: [{ slug: "../escape", name: "x" }] }, { ...choices, organizations: [{ slug: "team", name: "\u001b[2J" }] }, { ...choices, organizations: [choices.organizations[0], choices.organizations[0]] }]) await assert.rejects(onboardingIdentity(origin, access, undefined, async () => response(b, 409)));
  await assert.rejects(onboardingIdentity(origin, access, undefined, async () => response({ error: "not_a_member" }, 401)), /HTTP_REFUSED/);
});
test("bootstrap rejects nonexplicit paths, existing profiles, symlink parents, public parent permissions and never imports old config", () => {
  const f = fixture();
  try {
    for (const path of ["relative/concourse-v3/agent", join(f.base, "other", "agent"), `${f.root}/../other`, join(f.base, "concourse-v3", "..")]) assert.throws(() => createProfile(path));
    const elsewhere = join(f.base, "elsewhere"); mkdirSync(elsewhere, { mode: 0o700 }); symlinkSync(elsewhere, join(f.base, "link"));
    assert.throws(() => createProfile(join(f.base, "link", "concourse-v3", "agent")));
    createProfile(f.root); assert.throws(() => createProfile(f.root));
    const files = new PrivateFiles(f.root); try { assert.equal(files.read("config.json"), undefined); } finally { files.close(); }
    const badParent = join(f.base, "public", "concourse-v3"); mkdirSync(badParent, { recursive: true, mode: 0o755 });
    // A restrictive caller umask must not silently turn this public-parent fixture private.
    chmodSync(badParent, 0o755);
    assert.throws(() => createProfile(join(badParent, "agent")), /parent.*0700/);
  } finally { f.cleanup(); }
});
test("auth-only configuration works before identity; final Config never accepts placeholders/missing identity", () => {
  const f = fixture(); createProfile(f.root); const files = new PrivateFiles(f.root);
  try {
    const c = { version: 3 as const, origin, issuer: EXPECTED_ISSUER, tokenEndpoint: issuerMetadata.token_endpoint, authorizationEndpoint: issuerMetadata.authorization_endpoint, oauthClientId: "synthetic", auth: { kind: "oauth" as const, redirectUri: "http://127.0.0.1:4444/callback" } };
    assert.doesNotThrow(() => new TokenClient(c, files, async () => { throw new Error("No calls allowed"); }));
    assert.throws(() => validateConfig(c as Config), /INVALID_EXPECTED_IDENTITY/);
  } finally { files.close(); f.cleanup(); }
});

test("invalid v2 provisioned draft shapes are refused before network and preserve draft/pending bytes", async () => {
  const valid = { version: 2, origin, agent: "my-agent", redirectUri: "http://127.0.0.1:4444/callback", registration: "provisioned", oauthClientId: provisionedUid, card: "unattempted" };
  const invalids = [
    { version: 3 }, { oauthClientId: undefined }, { oauthClientId: null }, { oauthClientId: 123 }, { oauthClientId: "" }, { oauthClientId: "bad.client" }, { oauthClientId: "x".repeat(2049) },
    { registration: "registered" }, { registration: "unattempted" }, { registration: "uncertain" }, { card: "unknown" }, { agent: "Wrong-Handle" },
    { redirectUri: "http://localhost:4444/callback" }, { redirectUri: "http://127.0.0.1:0/callback" }, { redirectUri: "http://127.0.0.1:4444/elsewhere" },
  ];
  for (const invalid of invalids) {
    const f = fixture(); createProfile(f.root); const files = new PrivateFiles(f.root);
    try {
      files.write("onboarding.json", { ...valid, ...invalid }); files.write("oauth-pending.json", { verifier: "synthetic-private-pending" }); files.close();
      const names = ["onboarding.json", "oauth-pending.json"], saved = names.map(name => readFileSync(join(f.root, name)));
      await assert.rejects(signup({ profile: f.root, resume: true }, f.deps), (e: unknown) => e instanceof SafeError && e.code === "INVALID_ONBOARDING_DRAFT" && !e.uncertain);
      names.forEach((name, i) => assert.deepEqual(readFileSync(join(f.root, name)), saved[i]));
      assert.equal(f.calls.length, 0); assert.deepEqual(f.events, []); assert.equal(f.read("tokens.json"), undefined); assert.equal(f.read("oauth-exchange.json"), undefined);
    } finally { files.close(); f.cleanup(); }
  }
});
test("provisioned resume preserves pending and token resource/issuer/client/redirect binding fences without DCR", async () => {
  for (const field of ["resource", "issuer", "clientId", "redirectUri", "token-clientId"]) {
    const f = fixture(); f.state.pauseOAuth = true;
    try {
      await assert.rejects(signup(f.options, { ...f.deps, timeoutMs: 20 }), /CALLBACK_TIMEOUT/);
      const files = new PrivateFiles(f.root);
      const name = field === "token-clientId" ? "tokens.json" : "oauth-pending.json";
      try {
        if (field === "token-clientId") files.write(name, { access, refresh, expires: Date.now() + 300_000, resource: origin, issuer: EXPECTED_ISSUER, clientId: "synthetic-other-client" });
        else files.write(name, { ...files.read<Record<string, unknown>>(name), [field]: field === "clientId" ? "synthetic-other-client" : "https://substitution.invalid" });
      } finally { files.close(); }
      const saved = readFileSync(join(f.root, name)), count = f.calls.length, events = f.events.length;
      await assert.rejects(signup({ profile: f.root, resume: true }, f.deps), field === "token-clientId" ? /TOKEN_BINDING_MISMATCH/ : /OAUTH_PENDING_BINDING_MISMATCH/);
      assert.deepEqual(readFileSync(join(f.root, name)), saved); assert.equal(f.calls.length, count); assert.equal(f.events.length, events);
      assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0);
    } finally { f.cleanup(); }
  }
});
test("setup bridge callback separately checks fresh state, host, method, exact query and safe organization", async () => {
  const listener = new Loopback(); await listener.bind();
  try {
    const state = "s".repeat(43), wait = listener.wait("/setup-complete", state, 1000);
    const valid = new URLSearchParams({ state, organization: "team" }), base = `http://127.0.0.1:${listener.port}/setup-complete?${valid}`;
    for (const options of [{ method: "POST" }, { host: "evil.invalid" }, { path: `/setup-complete?${valid}&organization=other` }, { path: `/setup-complete?${valid}&identity=forged` }, { path: "/setup-complete?state=wrong&organization=team" }, { path: `/setup-complete?${new URLSearchParams({ state, organization: "../evil" })}` }]) assert.equal(await callback(base, options), 400);
    assert.equal(await callback(base), 200); assert.equal((await wait).get("organization"), "team");
    assert.equal(await callback(base), 400);
  } finally { await listener.close(); }
});
test("known card refusal stays refused on resume even when an existing handle matches", async () => {
  const f = fixture(); f.state.handle = "my-agent"; f.state.cardRefused = true;
  try {
    await assert.rejects(signup(f.options, f.deps), /CARD_WRITE_REFUSED/);
    assert.equal(f.read<Draft>("onboarding.json")!.card, "refused");
    const before = f.calls.length;
    await assert.rejects(signup({ profile: f.root, resume: true }, f.deps), /CARD_WRITE_REFUSED/);
    assert.equal(f.calls.length, before); assert.equal(f.read("config.json"), undefined);
  } finally { f.cleanup(); }
});
test("actual CLI JSON phases and doctor are nonsecret; token exchange uncertainty redacts provider text and never registers", async () => {
  const { main } = await import("../cli.ts");
  const f = fixture(), output: string[] = []; f.state.admitted = false;
  try {
    const noSpawn = async () => { throw new Error("No process operations permitted"); };
    assert.equal(await main(["signup", "--origin", origin, "--agent", "my-agent", "--oauth-client-id", provisionedUid, "--profile", f.root, "--json"], noSpawn, line => output.push(line), f.deps), 0);
    assert.deepEqual(output.map(l => JSON.parse(l).phase), ["authorization", "web_admission", "complete"]);
    assert.equal(await main(["doctor", "--profile", f.root, "--json"], noSpawn, line => output.push(line), f.deps), 0);
    for (const secret of [access, refresh, code, "code_verifier"]) assert.equal(output.join("\n").includes(secret), false);
    const second = join(f.base, "concourse-v3", "another-agent");
    const failed: Fetch = async (url, init) => { if (String(url).endsWith("/oauth/token")) throw new Error(`remote error ${access} ${refresh}`); return f.fetchImpl(url, init); };
    const open = async (url: string) => { const action = new URL(url), target = new URL(action.searchParams.get("redirect_uri")!); target.search = new URLSearchParams({ code, state: action.searchParams.get("state")!, iss: EXPECTED_ISSUER }).toString(); assert.equal(await callback(target.href), 400); };
    assert.equal(await main(["signup", "--origin", origin, "--agent", "my-agent", "--oauth-client-id", provisionedUid, "--profile", second, "--json"], noSpawn, line => output.push(line), { fetchImpl: failed, open }), 1);
    const last = JSON.parse(output.at(-1)!); assert.equal(last.phase, "blocked"); assert.equal(last.error, "TRANSPORT_FAILED"); assert.equal(last.uncertain, true);
    assert.equal(await main(["signup", "--resume", "--profile", second, "--json"], noSpawn, line => output.push(line), { fetchImpl: failed, open }), 1);
    assert.equal(JSON.parse(output.at(-1)!).error, "OAUTH_EXCHANGE_UNCERTAIN");
    for (const secret of [access, refresh, code, "remote error"]) assert.equal(output.join("\n").includes(secret), false);
    assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0);
  } finally { f.cleanup(); }
});
test("signup refuses a config that appears during onboarding rather than overwrite a configured identity", async () => {
  const f = fixture(), existing = { version: 3, owner: "preserved-owner", agent: "preserved-agent" };
  const transport: Fetch = async (u, init) => {
    const r = await f.fetchImpl(u, init);
    if (String(u).endsWith("/api/card")) {
      const files = new PrivateFiles(f.root); try { files.write("config.json", existing); } finally { files.close(); }
    }
    return r;
  };
  try {
    await assert.rejects(signup(f.options, { ...f.deps, fetchImpl: transport }), /PROFILE_ALREADY_CONFIGURED/);
    assert.deepEqual(f.read("config.json"), existing);
  } finally { f.cleanup(); }
});

test("authorization denial promptly releases signup listener/lock, does not exchange, and resumes the same unexchanged intent", { timeout: 3000 }, async t => {
  const f = fixture();
  const originalComplete = TokenClient.prototype.completeAuthorization; let exchanges = 0;
  t.mock.method(TokenClient.prototype, "completeAuthorization", function (this: TokenClient, ...args: Parameters<typeof originalComplete>) { exchanges++; return originalComplete.apply(this, args); });
  try {
    const deny = async (url: string) => {
      const action = new URL(url), target = new URL(action.searchParams.get("redirect_uri")!);
      target.search = new URLSearchParams({ error: "access_denied", state: action.searchParams.get("state")!, iss: EXPECTED_ISSUER, error_description: "synthetic-private-provider-text", error_uri: "https://issuer.invalid/private-provider-text" }).toString();
      assert.equal(await callback(target.href), 200);
    };
    await assert.rejects(signup(f.options, { ...f.deps, timeoutMs: 300_000, open: deny }), (e: unknown) => e instanceof SafeError && e.code === "AUTHORIZATION_DENIED" && e.message === "AUTHORIZATION_DENIED");
    const draft = f.read<Draft>("onboarding.json")!, pending = f.read("oauth-pending.json");
    assert.ok(pending); assert.equal(f.read("oauth-exchange.json"), undefined); assert.equal(f.read("tokens.json"), undefined); assert.equal(f.read("config.json"), undefined);
    assert.equal(exchanges, 0); assert.equal(f.calls.filter(c => c.path === "/oauth/token").length, 0); assert.equal(f.calls.filter(c => c.path === "/api/card").length, 0);
    assert.equal(JSON.stringify(f.events).includes("private-provider-text"), false);
    await assert.rejects(callback(draft.redirectUri), /ECONNREFUSED/);
    const files = new PrivateFiles(f.root); const release = files.acquire(); release(); files.close();
    const firstUrl = (f.events[0] as { actionUrl: string }).actionUrl;
    assert.equal(await signup({ profile: f.root, resume: true }, f.deps), "complete");
    assert.equal((f.events[1] as { actionUrl: string }).actionUrl, firstUrl, "denial leaves the unexchanged state/verifier reusable as before");
    assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0); assert.equal(f.calls.filter(c => c.path === "/oauth/token").length, 1); assert.equal(exchanges, 1);
    assert.equal(f.read<Draft>("onboarding.json")!.oauthClientId, provisionedUid); assert.equal(f.read<Draft>("onboarding.json")!.redirectUri, draft.redirectUri);
  } finally { t.mock.restoreAll(); f.cleanup(); }
});

const longOrganizations = ["a".repeat(101), "b".repeat(120), `${"c".repeat(120)}-10`];
const invalidOrganizations = ["", "Team", "under_score", "-team", "team-", "team--other", "a/b", "a%2fb", "team\r\n", "team\n", "team\u2028", "../escape"];

test("organization slug contract matches Rails lexical format without a length cap; owner/agent bounds remain", () => {
  const base = { version: 3 as const, origin, issuer: EXPECTED_ISSUER, tokenEndpoint: issuerMetadata.token_endpoint, oauthClientId: "synthetic", auth: { kind: "client_credentials" as const, clientSecret: "synthetic-secret" }, owner: "owner", agent: "agent" };
  for (const organization of ["a", "team-2", ...longOrganizations]) {
    assert.equal(validOrganizationSlug(organization), true);
    assert.equal(validateConfig({ ...base, organization }).organization, organization);
  }
  for (const organization of [...invalidOrganizations, null, 123]) {
    assert.equal(validOrganizationSlug(organization), false);
    assert.throws(() => validateConfig({ ...base, organization } as Config), /INVALID_EXPECTED_IDENTITY/);
  }
  for (const field of ["owner", "agent"]) assert.throws(() => validateConfig({ ...base, organization: longOrganizations[0], [field]: "x".repeat(101) }), /INVALID_EXPECTED_IDENTITY/);
});

test("long organization browser hints reach actual loopback, authenticated identity, final config and CLI doctor", async () => {
  const { main } = await import("../cli.ts");
  for (const organization of longOrganizations) {
    const f = fixture(); f.state.admitted = false; f.state.members = [organization];
    const output: string[] = [], noSpawn = async () => { throw new Error("No process operations permitted"); };
    try {
      assert.equal(await main(["signup", "--origin", origin, "--agent", "my-agent", "--oauth-client-id", provisionedUid, "--profile", f.root, "--json"], noSpawn, line => output.push(line), f.deps), 0);
      assert.deepEqual(output.map(line => JSON.parse(line).phase), ["authorization", "web_admission", "complete"]);
      assert.equal(f.read<Config>("config.json")!.organization, organization);
      assert.equal(validateConfig(f.read<Config>("config.json")!).organization, organization);
      assert.equal(await main(["doctor", "--profile", f.root, "--json"], noSpawn, line => output.push(line), f.deps), 0);
      assert.equal(JSON.parse(output.at(-1)!).identity.organization, organization);
    } finally { f.cleanup(); }
  }
});

test("long existing organization choices resume through CLI and revalidate a persisted identity without re-registration or PATCH replay", async () => {
  const { main } = await import("../cli.ts");
  for (const organization of longOrganizations) {
    const f = fixture(); f.state.members = ["first", organization];
    const noSpawn = async () => { throw new Error("No process operations permitted"); };
    try {
      const callbacks: Promise<void>[] = [];
      const emit = (e: SetupEvent) => { f.events.push(e); if (e.phase === "authorization") callbacks.push(f.open(e.actionUrl)); };
      assert.equal(await signup({ ...f.options, noOpen: true }, { ...f.deps, emit }), "organization_choice");
      await Promise.all(callbacks);
      const choice = f.events.find(e => e.phase === "organization_choice");
      assert.ok(choice?.phase === "organization_choice");
      assert.equal(choice.organizations[1].slug, organization);
      f.state.cardLost = true; f.state.cardApplied = false;
      await assert.rejects(signup({ profile: f.root, resume: true, organization, noOpen: true }, f.deps), /CARD_WRITE_UNCONFIRMED/);
      assert.equal(f.read<Draft>("onboarding.json")!.identity!.organization, organization);
      f.state.handle = "my-agent";
      assert.equal(await main(["signup", "--resume", "--organization", organization, "--profile", f.root, "--no-open", "--json"], noSpawn, () => {}, f.deps), 0);
      assert.equal(f.read<Config>("config.json")!.organization, organization);
      assert.equal((await doctor(f.root, f.fetchImpl)).identity.organization, organization);
      assert.equal(f.calls.filter(c => c.path === "/oauth/register").length, 0);
      assert.equal(f.calls.filter(c => c.path === "/api/card").length, 1);
    } finally { f.cleanup(); }
  }
});

test("invalid organization slugs fail in options, 409 choices and authenticated identity", async () => {
  for (const organization of invalidOrganizations) {
    await assert.rejects(onboardingIdentity(origin, access, undefined, async () => response({ error: "organization_required", message: "Choose", organizations: [{ slug: organization, name: "Team" }] }, 409)), /INVALID_ONBOARDING_RESPONSE/);
    const f = fixture();
    try {
      await assert.rejects(signup({ ...f.options, organization }, f.deps), /INVALID_ORGANIZATION/);
      assert.equal(f.calls.length, 0);
      const transport: Fetch = async (u, init) => {
        const r = await f.fetchImpl(u, init);
        if (String(u).endsWith("/api/identity") && r.ok) return response({ ...await r.json(), organization });
        return r;
      };
      await assert.rejects(signup(f.options, { ...f.deps, fetchImpl: transport }), /V3_IDENTITY_REFUSED/);
      assert.equal(f.calls.filter(c => c.path === "/api/card").length, 0);
      assert.equal(f.read("config.json"), undefined);
    } finally { f.cleanup(); }
  }
});

test("invalid loopback organization fields do not consume the pending callback; URL size bounds remain", async () => {
  const listener = new Loopback(); await listener.bind();
  try {
    const state = "s".repeat(43), wait = listener.wait("/setup-complete", state, 5000);
    void wait.catch(() => {});
    const target = (organization: string) => `http://127.0.0.1:${listener.port}/setup-complete?${new URLSearchParams({ state, organization })}`;
    for (const organization of invalidOrganizations) assert.equal(await callback(target(organization)), 400);
    // The existing HTTP header bound may reject the request line before our URL bound.
    await assert.rejects(callback(target("x".repeat(8200))), /socket hang up/);
    assert.equal(await callback(target(longOrganizations[2])), 200);
    assert.equal((await wait).get("organization"), longOrganizations[2]);
  } finally { await listener.close(); }
});
