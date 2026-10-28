import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { signup, doctor, EXPECTED_ISSUER, type Draft, type SetupEvent, type SetupDependencies } from "../src/onboarding.ts";
import { PrivateFiles } from "../src/storage.ts";
import { SafeError, type Fetch } from "../src/http.ts";
import type { Config } from "../src/auth.ts";

const origin = "https://concourse.krishnan.ca";
const endpoint = `${EXPECTED_ISSUER}/oauth/concourse_v3/registrations`;
const clientId = "synthetic-fresh-native-client";
const access = "synthetic.access", refresh = "synthetic.refresh";
function callback(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    assert.equal(url.hostname, "127.0.0.1");
    const req = request(url, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    req.once("error", reject); req.end();
  });
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "concourse-auto-signup-")), profile = join(base, "concourse-v3", "synthetic");
  const calls: string[] = [], events: SetupEvent[] = [];
  const state = { status: 201, lost: false, badJson: false, badDiscovery: false, pause: false, denied: false, tokenLost: false, admitted: false, admissionReason: undefined as string | undefined, admitBrowser: true, named: false, wrongClient: false, body: (value: Record<string, unknown>): unknown => value };
  function read<T>(name: string): T | undefined { const files = new PrivateFiles(profile); try { return files.read<T>(name); } finally { files.close(); } }
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.href);
    assert.ok([origin, EXPECTED_ISSUER].includes(url.origin), "synthetic transport never contacts another host");
    assert.equal(init?.redirect, "error");
    if (url.pathname.startsWith("/.well-known/")) {
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return Response.json(url.origin === origin ? { resource: state.badDiscovery ? "wrong" : origin, authorization_servers: [EXPECTED_ISSUER] } : {
        issuer: EXPECTED_ISSUER, authorization_endpoint: `${EXPECTED_ISSUER}/oauth/authorize`, token_endpoint: `${EXPECTED_ISSUER}/oauth/token`,
        // Deliberately legacy: automatic signup must use only the negotiated route.
        registration_endpoint: `${EXPECTED_ISSUER}/oauth/register`, code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (url.href === endpoint) {
      assert.equal(init?.method, "POST");
      const draft = read<Draft>("onboarding.json")!;
      assert.equal(draft.version, 3); assert.equal(draft.registration, "uncertain"); assert.equal(draft.oauthClientId, undefined);
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), { client_name: "Concourse v3 synthetic", redirect_uris: [draft.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "concourse" });
      assert.ok(Buffer.byteLength(String(init?.body)) <= 8192);
      if (state.lost) throw new Error("synthetic registration response lost");
      if (state.status >= 300 && state.status < 400) return new Response(null, { status: state.status, headers: { location: "https://attacker.invalid/register" } });
      if (state.badJson) return new Response("not JSON", { status: state.status });
      return Response.json(state.body({ client_id: clientId, client_name: "Concourse v3 synthetic", redirect_uris: [draft.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "concourse", client_id_issued_at: 1_790_000_000, application_type: "native" }), { status: state.status });
    }
    if (url.pathname === "/oauth/register") assert.fail("never fall back to ordinary DCR");
    if (url.pathname === "/oauth/token") {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("client_id"), clientId); assert.equal(body.get("resource"), origin); assert.equal(body.get("scope"), "concourse");
      assert.equal(body.get("redirect_uri"), read<Draft>("onboarding.json")!.redirectUri);
      assert.equal(body.get("code_verifier")?.length, 43); assert.equal(body.has("client_secret"), false);
      assert.equal(read("oauth-exchange.json"), true); assert.equal(read("oauth-pending.json"), null);
      if (state.tokenLost) throw new Error("synthetic code exchange lost");
      return Response.json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: "concourse" });
    }
    assert.equal(url.origin, origin); assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${access}`);
    assert.equal(new Headers(init?.headers).get("Concourse-Organization"), "example-team");
    if (url.pathname === "/api/identity") {
      if (!state.admitted) return Response.json({ error: "not_a_member", ...(state.admissionReason ? { reason: state.admissionReason } : {}) }, { status: 403 });
      return Response.json({ release_line: 3, owner: "synthetic-owner", organization: "example-team", agent_id: 42, oauth_client_id: state.wrongClient ? "other-client" : clientId, handle: state.named ? "synthetic" : null, network_agent: "concourse/network-4" });
    }
    assert.equal(url.pathname, "/api/card"); assert.equal(init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(init?.body)), { handle: "synthetic", name: "synthetic", harness: "pi" });
    state.named = true; return Response.json({});
  };
  const open = async (url: string) => {
    const action = new URL(url);
    if (action.origin === EXPECTED_ISSUER) {
      assert.equal(action.pathname, "/oauth/authorize"); assert.equal(action.searchParams.get("client_id"), clientId);
      assert.equal(action.searchParams.get("resource"), origin); assert.equal(action.searchParams.get("scope"), "concourse");
      assert.equal(action.searchParams.get("code_challenge_method"), "S256");
      assert.equal(read<Draft>("onboarding.json")!.registration, "registered");
      if (state.pause) return;
      const target = new URL(action.searchParams.get("redirect_uri")!);
      const pending = read("oauth-pending.json");
      assert.equal(await callback(new URL("/", target)), 400, "a bare-root connectivity probe is non-consuming");
      assert.deepEqual(read("oauth-pending.json"), pending);
      target.search = new URLSearchParams({ ...(state.denied ? { error: "access_denied" } : { code: "synthetic-code" }), state: action.searchParams.get("state")!, iss: EXPECTED_ISSUER }).toString();
      assert.equal(await callback(target), state.tokenLost ? 400 : 200);
    } else {
      assert.equal(action.origin, origin); assert.equal(action.pathname, "/developer/setup");
      if (state.admitBrowser) state.admitted = true;
      assert.equal(await callback(new URL(`http://127.0.0.1:${action.searchParams.get("port")}/setup-complete?${new URLSearchParams({ state: action.searchParams.get("state")!, organization: "example-team" })}`)), 200);
    }
  };
  const deps: SetupDependencies = { fetchImpl, open, emit: event => events.push(event), timeoutMs: 1000 };
  return { base, profile, state, read, calls, events, open, deps, options: { profile, origin, agent: "synthetic", organization: "example-team" }, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("automatic fresh registration -> PKCE -> verified web admission -> authenticated identity -> card -> runtime config/doctor", async () => {
  const f = fixture();
  try {
    assert.equal(await signup(f.options, f.deps), "complete");
    assert.deepEqual(f.events.map(e => e.phase), ["authorization", "web_admission", "complete"]);
    assert.equal(f.calls.filter(path => path === endpoint).length, 1);
    const draft = f.read<Draft>("onboarding.json")!; assert.equal(draft.version, 3); assert.equal(draft.registration, "registered");
    const config = f.read<Config>("config.json")!; assert.equal(config.oauthClientId, clientId); assert.equal(config.owner, "synthetic-owner"); assert.equal(config.organization, "example-team");
    assert.equal((await doctor(f.profile, f.deps.fetchImpl)).phase, "healthy");
    const output = JSON.stringify(f.events); for (const secret of [access, refresh, "synthetic-code"]) assert.equal(output.includes(secret), false);
  } finally { f.cleanup(); }
});

test("prepared discovery failure resumes the same actual callback and registers only once", async () => {
  const f = fixture(); f.state.badDiscovery = true;
  try {
    await assert.rejects(signup(f.options, f.deps), /RESOURCE_METADATA_REFUSED/);
    const before = f.read<Draft>("onboarding.json")!; assert.equal(before.registration, "prepared"); assert.equal(f.calls.includes(endpoint), false);
    f.state.badDiscovery = false; await signup({ profile: f.profile, resume: true, organization: "example-team" }, f.deps);
    assert.equal(f.read<Draft>("onboarding.json")!.redirectUri, before.redirectUri); assert.equal(f.calls.filter(path => path === endpoint).length, 1);
  } finally { f.cleanup(); }
});

test("registered timeout resumes exact UID/port/PKCE without registration or replacing pending intent", async () => {
  const f = fixture(); f.state.pause = true;
  try {
    await assert.rejects(signup(f.options, { ...f.deps, timeoutMs: 20 }), /CALLBACK_TIMEOUT/);
    const before = f.read<Draft>("onboarding.json")!, pending = f.read("oauth-pending.json");
    f.state.pause = false; await signup({ profile: f.profile, resume: true, organization: "example-team" }, f.deps);
    assert.equal(f.read<Draft>("onboarding.json")!.redirectUri, before.redirectUri);
    assert.equal(f.read<Draft>("onboarding.json")!.oauthClientId, before.oauthClientId);
    const urls = f.events.filter(e => e.phase === "authorization"); assert.equal(urls.length, 2); assert.deepEqual(urls[0], urls[1]);
    assert.ok(pending); assert.equal(f.calls.filter(path => path === endpoint).length, 1);
  } finally { f.cleanup(); }
});

for (const failure of ["lost", "500", "redirect", "invalid-json", "wrong-success-status"]) test(`registration ${failure} retains an uncertain fence and cannot POST again on resume`, async () => {
  const f = fixture();
  if (failure === "lost") f.state.lost = true;
  if (failure === "500") f.state.status = 500;
  if (failure === "redirect") f.state.status = 302;
  if (failure === "invalid-json") f.state.badJson = true;
  if (failure === "wrong-success-status") f.state.status = 200;
  try {
    await assert.rejects(signup(f.options, f.deps), (e: unknown) => e instanceof SafeError && e.code === "REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER" && e.uncertain);
    assert.equal(f.read<Draft>("onboarding.json")!.registration, "uncertain"); assert.equal(f.read("config.json"), undefined);
    const count = f.calls.length;
    await assert.rejects(signup({ profile: f.profile, resume: true }, f.deps), /REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER/);
    assert.equal(f.calls.length, count); assert.equal(f.calls.filter(path => path === endpoint).length, 1);
    assert.deepEqual(f.events, []);
  } finally { f.cleanup(); }
});

for (const status of [400, 401, 403, 404, 429]) test(`explicit registration HTTP${status} is refused with no DCR fallback or resume retry`, async () => {
  const f = fixture(); f.state.status = status;
  try {
    await assert.rejects(signup(f.options, f.deps), (e: unknown) => e instanceof SafeError && e.code === "V3_REGISTRATION_REFUSED" && !e.uncertain && e.status === status);
    assert.equal(f.read<Draft>("onboarding.json")!.registration, "refused"); const count = f.calls.length;
    await assert.rejects(signup({ profile: f.profile, resume: true }, f.deps), /V3_REGISTRATION_REFUSED/);
    assert.equal(f.calls.length, count); assert.equal(f.read("oauth-pending.json"), undefined);
  } finally { f.cleanup(); }
});

test("registration response requires the exact negotiated nine public fields, never trusts extra policy or privileges", async () => {
  const mutations = [
    (b: Record<string, unknown>) => ({ ...b, client_secret: "unrequested" }),
    (b: Record<string, unknown>) => ({ ...b, registration_policy: "legacy_concourse_v3" }),
    (b: Record<string, unknown>) => ({ ...b, registration_access_token: "unrequested" }),
    (b: Record<string, unknown>) => ({ ...b, concourse_resource_origin: origin }),
    (b: Record<string, unknown>) => ({ ...b, redirect_uris: ["http://localhost:4444/callback"] }),
    (b: Record<string, unknown>) => ({ ...b, client_id: "https://attacker.invalid" }),
    (b: Record<string, unknown>) => ({ ...b, client_id: "id\n" }),
    (b: Record<string, unknown>) => ({ ...b, scope: "concourse openid" }),
    (b: Record<string, unknown>) => ({ ...b, application_type: "web" }),
    (b: Record<string, unknown>) => ({ ...b, grant_types: ["client_credentials"] }),
    (b: Record<string, unknown>) => ({ ...b, token_endpoint_auth_method: "client_secret_basic" }),
    (b: Record<string, unknown>) => ({ ...b, client_id_issued_at: -1 }),
    (b: Record<string, unknown>) => ({ ...b, client_name: "bad\nname" }),
    (b: Record<string, unknown>) => { const { application_type, ...missing } = b; return missing; }
  ];
  for (const body of mutations) {
    const f = fixture(); f.state.body = body;
    try {
      await assert.rejects(signup(f.options, f.deps), /REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER/);
      assert.equal(f.read<Draft>("onboarding.json")!.registration, "uncertain"); assert.equal(f.read<Draft>("onboarding.json")!.oauthClientId, undefined);
      assert.equal(f.read("tokens.json"), undefined); assert.deepEqual(f.events, []);
      const count = f.calls.length; await assert.rejects(signup({ profile: f.profile, resume: true }, f.deps), /REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER/); assert.equal(f.calls.length, count);
    } finally { f.cleanup(); }
  }
});

test("ineligible issuer account denial never exchanges; browser hint without actual membership never enrolls", async () => {
  for (const denied of [true, false]) {
    const f = fixture(); f.state.denied = denied; f.state.admitBrowser = false;
    try {
      await assert.rejects(signup(f.options, f.deps), denied ? /AUTHORIZATION_DENIED/ : /WEB_ADMISSION_REQUIRED/);
      assert.equal(f.read("config.json"), undefined); assert.equal(f.calls.some(path => path.endsWith("/api/card")), false);
      if (denied) { assert.equal(f.calls.some(path => path.endsWith("/oauth/token")), false); assert.equal(f.read("tokens.json"), undefined); }
    } finally { f.cleanup(); }
  }
});

test("lost code exchange cannot regenerate registration or authorization; authenticated different client cannot publish", async () => {
  for (const tokenLost of [true, false]) {
    const f = fixture(); f.state.tokenLost = tokenLost; f.state.admitted = true; f.state.wrongClient = !tokenLost;
    try {
      await assert.rejects(signup(f.options, f.deps), tokenLost ? /TRANSPORT_FAILED/ : /V3_IDENTITY_REFUSED/);
      assert.equal(f.read("config.json"), undefined); assert.equal(f.calls.some(path => path.endsWith("/api/card")), false);
      if (tokenLost) { const count = f.calls.length; await assert.rejects(signup({ profile: f.profile, resume: true }, f.deps), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(f.calls.length, count); }
      assert.equal(f.calls.filter(path => path === endpoint).length, 1);
    } finally { f.cleanup(); }
  }
});

test("automatic registration is only for the canonical V3 resource before profile or network; explicit provisioned mode stays separate", async () => {
  const f = fixture();
  try {
    await assert.rejects(signup({ ...f.options, origin: "https://other.invalid" }, f.deps), /AUTOMATIC_V3_ORIGIN_REQUIRED/);
    assert.equal(existsSync(f.profile), false); assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});

test("actual automatic CLI no-open JSON emits the bound callback without spawning a browser", async () => {
  const { main } = await import("../cli.ts");
  const f = fixture(), output: string[] = [], callbacks: Promise<void>[] = [];
  try {
    const result = await main(["signup", "--origin", origin, "--profile", f.profile, "--agent", "synthetic", "--organization", "example-team", "--no-open", "--json"], async () => { throw new Error("No process spawn"); }, line => {
      output.push(line); const event = JSON.parse(line);
      if (event.phase === "authorization" || event.phase === "web_admission") callbacks.push(f.open(event.actionUrl));
    }, { ...f.deps, open: async () => { assert.fail("no-open must not spawn or open a browser"); } });
    await Promise.all(callbacks); assert.equal(result, 0);
    assert.deepEqual(output.map(line => JSON.parse(line).phase), ["authorization", "web_admission", "complete"]);
    assert.equal(f.calls.filter(path => path === endpoint).length, 1);
    for (const secret of [access, refresh, "synthetic-code"]) assert.equal(output.join("\n").includes(secret), false);
  } finally { f.cleanup(); }
});

test("automatic draft modes cannot reinterpret provisioned/legacy or prepopulate another client/identity", async () => {
  for (const change of [{ version: 2 }, { registration: "provisioned", oauthClientId: clientId }, { registration: "prepared", oauthClientId: clientId }, { registration: "registered" }, { registration: "registered", oauthClientId: "bad.id" }, { identity: {} }, { card: "confirmed" }, { registration: "bogus" }]) {
    const f = fixture(); f.state.badDiscovery = true;
    try {
      await assert.rejects(signup(f.options, f.deps), /RESOURCE_METADATA_REFUSED/);
      const files = new PrivateFiles(f.profile);
      try { files.write("onboarding.json", { ...files.read<Draft>("onboarding.json")!, ...change }); } finally { files.close(); }
      const saved = readFileSync(join(f.profile, "onboarding.json")), count = f.calls.length;
      await assert.rejects(signup({ profile: f.profile, resume: true }, f.deps), /INVALID_ONBOARDING_DRAFT/);
      assert.deepEqual(readFileSync(join(f.profile, "onboarding.json")), saved); assert.equal(f.calls.length, count);
      assert.equal(f.read("config.json"), undefined); assert.equal(f.read("oauth-pending.json"), undefined);
    } finally { f.cleanup(); }
  }
});

test("cancellation after registration HTTP preserves its unknown fence rather than retrying a possibly created client", async () => {
  const f = fixture(), controller = new AbortController();
  try {
    const fetchImpl: Fetch = async (input, init) => { const result = await f.deps.fetchImpl!(input, init); if (String(input) === endpoint) controller.abort(); return result; };
    await assert.rejects(signup(f.options, { ...f.deps, fetchImpl, signal: controller.signal }), (e: unknown) => e instanceof SafeError && e.code === "REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER" && e.uncertain);
    assert.equal(f.read<Draft>("onboarding.json")!.registration, "uncertain"); const count = f.calls.length;
    await assert.rejects(signup({ profile: f.profile, resume: true }, f.deps), /REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER/);
    assert.equal(f.calls.length, count); assert.equal(f.read("config.json"), undefined);
  } finally { f.cleanup(); }
});

test("one owner approval still needs the browser continuation, not another approval or a poll", async () => {
  const f = fixture(); f.state.admissionReason = "awaiting_approval"; f.state.admitBrowser = false;
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const run = signup(f.options, { ...f.deps, timeoutMs: 5000, open: async value => {
    if (new URL(value).origin === EXPECTED_ISSUER) return f.open(value);
    f.state.admitted = true; // One successful owner approval, without the browser callback.
    ready();
  } });
  try {
    await waiting;
    const event = f.events.find(e => e.phase === "web_admission")!;
    assert.equal(event.phase, "web_admission");
    assert.equal(event.reason, "awaiting_approval");
    assert.match(event.instructions, /organization owner.*approve/i);
    assert.match(event.instructions, /Continue in terminal/);
    assert.match(event.instructions, /Approval alone does not/);
    assert.equal(f.read("config.json"), undefined);
    assert.equal(f.calls.filter(path => path.endsWith("/api/identity")).length, 1);
    assert.equal(f.calls.some(path => path.endsWith("/api/card")), false);
    await f.open(event.actionUrl);
    assert.equal(await run, "complete");
    assert.equal(f.calls.filter(path => path === endpoint).length, 1);
    assert.equal(f.calls.filter(path => path.endsWith("/api/card")).length, 1);
  } finally { await run.catch(() => {}); f.cleanup(); }
});

test("declined admission stops before browser setup and can resume the same client after owner reconsideration", async () => {
  const f = fixture(); f.state.admissionReason = "declined";
  try {
    await assert.rejects(signup(f.options, f.deps), /AGENT_DECLINED/);
    assert.deepEqual(f.events.map(e => e.phase), ["authorization"]);
    assert.equal(f.read("config.json"), undefined);
    assert.equal(f.calls.some(path => path.endsWith("/api/card")), false);
    f.state.admitted = true;
    assert.equal(await signup({ profile: f.profile, resume: true, organization: "example-team" }, f.deps), "complete");
    assert.equal(f.calls.filter(path => path === endpoint).length, 1);
    assert.equal(f.calls.filter(path => path.endsWith("/oauth/token")).length, 1);
    assert.equal(f.events.filter(e => e.phase === "authorization").length, 1);
  } finally { f.cleanup(); }
});

for (const reason of ["awaiting_approval", "declined"]) test(`post-callback ${reason} retains a resumable profile instead of generic web admission`, async () => {
  const f = fixture(); f.state.admitBrowser = false;
  try {
    await assert.rejects(signup(f.options, { ...f.deps, open: async value => {
      if (new URL(value).origin === origin) f.state.admissionReason = reason;
      await f.open(value);
    } }), reason === "declined" ? /AGENT_DECLINED/ : /AGENT_AWAITING_APPROVAL/);
    assert.equal(f.read("config.json"), undefined);
    assert.equal(f.calls.some(path => path.endsWith("/api/card")), false);
    f.state.admitted = true;
    assert.equal(await signup({ profile: f.profile, resume: true, organization: "example-team" }, f.deps), "complete");
    assert.equal(f.calls.filter(path => path === endpoint).length, 1);
    assert.equal(f.calls.filter(path => path.endsWith("/api/card")).length, 1);
    assert.equal(f.events.filter(e => e.phase === "authorization").length, 1);
  } finally { f.cleanup(); }
});

for (const machine of [true, false]) test(`CLI ${machine ? "JSON" : "human"} explains approval and browser continuation separately`, async () => {
  const { main } = await import("../cli.ts");
  const f = fixture(), output: string[] = []; f.state.admissionReason = "awaiting_approval";
  try {
    assert.equal(await main(["signup", "--origin", origin, "--profile", f.profile, "--agent", "synthetic", "--organization", "example-team", ...(machine ? ["--json"] : [])], async () => { assert.fail("No process spawn"); }, line => output.push(line), f.deps), 0);
    const instructions = machine ? JSON.parse(output[1]).instructions : output[1];
    assert.match(instructions, /organization owner.*approve/i);
    assert.match(instructions, /Continue in terminal/);
    assert.match(instructions, /Approval alone does not/);
    if (machine) {
      assert.equal(JSON.parse(output[1]).phase, "web_admission");
      assert.equal(JSON.parse(output[1]).reason, "awaiting_approval");
      assert.equal(new URL(JSON.parse(output[1]).actionUrl).pathname, "/developer/setup");
    }
    for (const secret of [access, refresh, "synthetic-code"]) assert.equal(output.join("\n").includes(secret), false);
  } finally { f.cleanup(); }
});

for (const reason of ["awaiting_approval", "declined"]) test(`CLI ${reason} refusal explains same-profile recovery without signing in again`, async () => {
  const { main } = await import("../cli.ts");
  const f = fixture(), output: string[] = []; f.state.admissionReason = reason; f.state.admitBrowser = false;
  try {
    assert.equal(await main(["signup", "--origin", origin, "--profile", f.profile, "--agent", "synthetic", "--organization", "example-team", "--json"], async () => { assert.fail("No process spawn"); }, line => output.push(line), f.deps), 1);
    const blocked = JSON.parse(output.at(-1)!);
    assert.equal(blocked.phase, "blocked");
    assert.equal(blocked.error, reason === "declined" ? "AGENT_DECLINED" : "AGENT_AWAITING_APPROVAL");
    assert.match(blocked.recovery, /organization owner/i);
    assert.match(blocked.recovery, /--resume/);
    assert.match(blocked.recovery, /same profile/i);
    assert.equal(f.read("config.json"), undefined);
    assert.equal(f.calls.some(path => path.endsWith("/api/card")), false);
  } finally { f.cleanup(); }
});
