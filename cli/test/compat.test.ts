import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as launcher } from "../../pi/concourse-v3/cli.ts";
import { EXPECTED_ISSUER, AUTOMATIC_V3_ORIGIN } from "../../pi/concourse-v3/src/onboarding.ts";
import { PrivateFiles } from "../../pi/concourse-v3/src/storage.ts";
import type { Fetch } from "../../pi/concourse-v3/src/http.ts";
import { main } from "../src/main.ts";
import { cli, noNetwork } from "./fixture.ts";

// A synthetic issuer and Concourse for one agent's automatic native sign-up.
// The canonical names are only labels here: every request goes to this function.
function service(agent: string) {
  const origin = AUTOMATIC_V3_ORIGIN, issuer = EXPECTED_ISSUER, clientId = `synthetic-client-${agent}`, access = `synthetic.access.${agent}`;
  let named = false;
  const fetchImpl: Fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = (init.method ?? "GET").toUpperCase();
    assert.ok([origin, issuer].includes(url.origin)); assert.equal(init.redirect, "error");
    if (url.href === `${origin}/.well-known/oauth-protected-resource`) return Response.json({ resource: origin, authorization_servers: [issuer] });
    if (url.href === `${issuer}/.well-known/oauth-authorization-server`) return Response.json({ issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`, code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true, token_endpoint_auth_methods_supported: ["none"] });
    if (url.href === `${issuer}/oauth/concourse_v3/registrations`) {
      const body = JSON.parse(String(init.body));
      return Response.json({ client_id: clientId, client_name: body.client_name, redirect_uris: body.redirect_uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "concourse", client_id_issued_at: 1_790_000_000, application_type: "native" }, { status: 201 });
    }
    if (url.href === `${issuer}/oauth/token`) {
      const form = new URLSearchParams(String(init.body));
      assert.deepEqual([form.get("grant_type"), form.get("code"), form.get("client_id")], ["authorization_code", "synthetic-code", clientId]);
      return Response.json({ access_token: access, refresh_token: `synthetic.refresh.${agent}`, token_type: "Bearer", expires_in: 3600, scope: "concourse" });
    }
    assert.equal(url.origin, origin); assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${access}`);
    if (url.pathname === "/api/identity") return Response.json({ release_line: 3, owner: "synthetic-owner", organization: "example-team", agent_id: 42, oauth_client_id: clientId, handle: named ? agent : null, network_agent: "concourse/network-4" });
    if (url.pathname === "/api/card" && method === "PATCH") { named = true; return Response.json({}); }
    if (url.pathname === "/agents/42/tasks") return Response.json({ tasks: [], blockedTasks: [], nextPageToken: "" });
    throw new Error(`UNSUPPORTED_SYNTHETIC_HTTP ${method} ${url.href}`);
  };
  return { fetchImpl };
}
// The person's browser ends on the loopback address; `concourse callback` hands it over.
async function approve(home: string, actionUrl: string): Promise<void> {
  const action = new URL(actionUrl), target = new URL(action.searchParams.get("redirect_uri")!);
  target.search = new URLSearchParams({ code: "synthetic-code", state: action.searchParams.get("state")!, iss: EXPECTED_ISSUER }).toString();
  const r = await cli(["callback", target.href, "--json"], { home });
  assert.deepEqual([r.code, r.last()], [0, { phase: "complete", command: "callback", accepted: true }]);
}
function files(root: string) {
  return readdirSync(root).filter(n => !n.startsWith("tmp-")).sort().map(name => [name, (statSync(join(root, name)).mode & 0o777).toString(8)]);
}
function config(root: string) { const f = new PrivateFiles(root); try { return f.read<Record<string, unknown>>("config.json")!; } finally { f.close(); } }

test("a profile made by either the Pi launcher or this CLI works in the other", async t => {
  // Only the loopback callback may use real fetch; it never leaves this computer.
  noNetwork(t, url => url.protocol === "http:" && url.hostname === "127.0.0.1");
  const home = mkdtempSync(join(tmpdir(), "concourse-cli-compat-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const pending: Promise<void>[] = [];

  // 1. This CLI joins with its default profile path.
  const ours = service("cli-agent"), lines: string[] = [];
  const joined = await main(["join", "--agent", "cli-agent", "--organization", "example-team", "--no-open", "--json"], {
    out: line => { lines.push(line); const e = JSON.parse(line); if (e.phase === "authorization") pending.push(approve(home, e.actionUrl)); },
    err: line => lines.push(line), env: { HOME: home }, fetchImpl: ours.fetchImpl, setupTimeoutMs: 10_000,
  });
  await Promise.all(pending);
  assert.equal(joined, 0, lines.join("\n"));
  const events = lines.map(l => JSON.parse(l));
  assert.deepEqual(events.map(e => e.phase), ["authorization", "complete"]);
  assert.match(events[0].instructions, /The agent runs: concourse callback --url/);
  const cliRoot = join(home, ".local/state/concourse-v3/cli-agent");
  assert.equal(events[1].configPath, join(cliRoot, "config.json"));

  // 2. The repository's Pi launcher joins with an explicit profile under the same directory.
  const theirs = service("pi-agent"), launcherLines: string[] = [], piRoot = join(home, ".local/state/concourse-v3/pi-agent");
  const launched = await launcher(["join", "--agent", "pi-agent", "--organization", "example-team", "--profile", piRoot, "--no-open", "--json"], undefined, line => {
    launcherLines.push(line); const e = JSON.parse(line); if (e.phase === "authorization") pending.push(approve(home, e.actionUrl));
  }, { fetchImpl: theirs.fetchImpl, timeoutMs: 10_000 });
  await Promise.all(pending);
  assert.equal(launched, 0, launcherLines.join("\n"));

  // 3. Same files, permissions and configuration shape.
  assert.deepEqual(files(cliRoot), files(piRoot));
  assert.ok(files(cliRoot).every(([, mode]) => mode === "600"));
  assert.equal((statSync(cliRoot).mode & 0o777).toString(8), "700");
  assert.deepEqual(Object.keys(config(cliRoot)).sort(), Object.keys(config(piRoot)).sort());

  // 4. Each front end uses the other's profile.
  const who = await cli(["whoami", "--profile", "pi-agent", "--json"], { home, fetchImpl: theirs.fetchImpl });
  assert.equal(who.code, 0); assert.equal(who.last().result.handle, "pi-agent");
  assert.equal((await cli(["doctor", "--profile", piRoot], { home, fetchImpl: theirs.fetchImpl })).out[0], `Healthy: example-team/synthetic-owner/pi-agent at https://concourse.krishnan.ca\nProfile: ${piRoot}`);
  assert.equal((await cli(["inbox", "--profile", "pi-agent"], { home, fetchImpl: theirs.fetchImpl })).text, "Your inbox is empty.");
  const back: string[] = [];
  assert.equal(await launcher(["identity", "--profile", cliRoot, "--json"], undefined, l => back.push(l), { fetchImpl: ours.fetchImpl }), 0);
  assert.equal(JSON.parse(back[0]).result.handle, "cli-agent");
  assert.equal(await launcher(["doctor", "--profile", cliRoot, "--json"], undefined, l => back.push(l), { fetchImpl: ours.fetchImpl }), 0);
  assert.equal(JSON.parse(back[1]).identity.agent, "cli-agent");

  // 5. A second join of a finished profile only checks it, in both front ends.
  const again = await cli(["join", "--agent", "pi-agent", "--json"], { home, fetchImpl: theirs.fetchImpl });
  assert.deepEqual([again.code, again.last().phase], [0, "complete"]);
});
