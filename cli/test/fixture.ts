import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, type TestContext } from "node:test";
import { PrivateFiles } from "../../pi/concourse-v3/src/storage.ts";
import type { Config } from "../../pi/concourse-v3/src/auth.ts";
import type { Fetch } from "../../pi/concourse-v3/src/http.ts";
import type { Task } from "../../pi/concourse-v3/src/types.ts";
import { main, type Io } from "../src/main.ts";

// Synthetic service only: an invalid origin, a fixture token and no real network.
export const origin = "https://concourse.invalid";
export const token = "synthetic-access-not-a-credential";
export const config: Config = { version: 3, origin, organization: "test", owner: "owner", agent: "me", oauthClientId: "synthetic-client", issuer: "https://issuer.invalid", tokenEndpoint: "https://issuer.invalid/token", auth: { kind: "client_credentials", clientSecret: "synthetic-not-a-credential" } };
export const identity = { release_line: 3, organization: "test", owner: "owner", handle: "me", oauth_client_id: "synthetic-client", agent_id: 7, network_agent: "concourse/network-1" };
export const TASK = "00000000-0000-4000-8000-000000000001";
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
export const task = (state = "TASK_STATE_SUBMITTED", extra: Partial<Task> = {}): Task => ({ id: TASK, contextId: "context-1", status: { state }, ...extra });

// A2A v1.0 §8.3 agent card, as Concourse serves it for each address.
export function card(recipient: string) {
  const url = `${origin}/a2a/test/${recipient}`;
  return { name: recipient, description: "Synthetic peer", version: "1.0.0", supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [] };
}

export interface Call { method: string; url: URL; headers: Headers; body?: any }
export class Server {
  calls: Call[] = [];
  routes = new Map<string, (call: Call) => Response | Promise<Response>>();
  // JSON-RPC result for a POST to an agent address, or a full Response.
  rpc: (body: any, recipient: string) => unknown = () => ({ task: task() });
  fetch: Fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase(), headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, url, headers, body }; this.calls.push(call);
    assert.equal(init.redirect, "error", "every request refuses redirects");
    assert.equal(url.origin, origin, "no other host is contacted");
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    const route = this.routes.get(`${method} ${url.pathname}`);
    if (route) return route(call);
    if (method === "GET" && url.pathname === "/api/identity") return json(identity);
    const a2a = /^\/a2a\/test\/([^/]+\/[^/]+)(\/\.well-known\/agent-card\.json)?\/?$/.exec(url.pathname);
    if (a2a && method === "GET" && a2a[2]) return json(card(a2a[1]));
    if (a2a && method === "POST") {
      const result = await this.rpc(body, a2a[1]);
      return result instanceof Response ? result : json({ jsonrpc: "2.0", id: body.id, result });
    }
    throw new Error(`UNSUPPORTED_SYNTHETIC_HTTP ${method} ${url.pathname}`);
  };
  posts(): Call[] { return this.calls.filter(c => c.method === "POST"); }
  paths(): string[] { return this.calls.map(c => `${c.method} ${c.url.pathname}${c.url.search}`); }
}

// A signed-in profile at the Pi extension's default location under a temporary HOME.
export function profile(t: TestContext, name = "me") {
  const home = mkdtempSync(join(tmpdir(), "concourse-cli-test-"));
  const root = join(home, ".local/state/concourse-v3", name);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = new PrivateFiles(root);
  try {
    files.write("config.json", config);
    files.write("tokens.json", { access: token, expires: Date.now() + 3600_000, resource: origin, issuer: config.issuer, clientId: config.oauthClientId });
  } finally { files.close(); }
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const read = <T>(file: string): T | undefined => { const f = new PrivateFiles(root); try { return f.read<T>(file); } finally { f.close(); } };
  return { home, root, read };
}

// Any request that escapes the injected synthetic transport fails the test.
export function noNetwork(t: TestContext, allow?: (url: URL) => boolean) {
  const real = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (allow?.(url)) return real(input, init);
    throw new Error(`FORBIDDEN_REAL_NETWORK ${url.origin}`);
  });
  t.after(() => mock.restoreAll());
}

export async function cli(argv: string[], io: Partial<Io> & { home: string }) {
  const out: string[] = [], err: string[] = [];
  const { home, ...rest } = io;
  let clock = 0;
  const code = await main(argv, { out: l => out.push(l), err: l => err.push(l), env: { HOME: home }, now: () => clock, sleep: async ms => { clock += ms; }, ...rest });
  return { code, out, err, text: out.join("\n"), last: () => JSON.parse(out.at(-1)!) };
}
