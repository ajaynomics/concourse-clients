import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { install } from "../index.ts";
import { FileJournal, PrivateFiles } from "../src/storage.ts";
import type { Config } from "../src/auth.ts";
import type { Fetch } from "../src/http.ts";
import { config as base, deferred, response, task } from "./helpers.ts";

// Fake Pi and fake HTTP only: two synthetic personal servers, no network, no model.
const alpha: Config = { ...base, origin: "https://alpha.invalid", organization: "team-alpha", owner: "owner", agent: "reviews" };
const beta: Config = { ...base, origin: "https://beta.invalid", organization: "team-beta", owner: "writer", agent: "notes" };

class Server {
  calls: { method: string; path: string }[] = []; failure?: number; doorbell: "open" | "drop" = "open"; hold?: Promise<void>; reached = deferred<void>();
  constructor(readonly config: Config, readonly taskId: string) {}
  fetch: Fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = (init.method ?? "GET").toUpperCase();
    this.calls.push({ method, path: url.pathname });
    if (this.failure) return response({}, this.failure);
    const c = this.config;
    if (url.pathname === "/api/identity") return response({ release_line: 3, organization: c.organization, owner: c.owner, handle: c.agent, oauth_client_id: c.oauthClientId, agent_id: 1, network_agent: "concourse/network-1" });
    if (url.pathname === "/api/doorbell") {
      if (this.doorbell === "drop") throw new Error("synthetic disconnect");
      const session = new Headers(init.headers).get("Concourse-Session-Id");
      return new Response(new ReadableStream({ start: s => {
        s.enqueue(new TextEncoder().encode(`event: ready\ndata: ${JSON.stringify({ release_line: 3, sessionId: session, connectionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" })}\n\n`));
        init.signal?.addEventListener("abort", () => { try { s.close(); } catch {} }, { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/agents/1/tasks") return response({ tasks: url.searchParams.get("pageToken") ? [] : [{ ...task(), id: this.taskId }], nextPageToken: "" });
    if (method === "PATCH" && url.pathname === `/tasks/${this.taskId}`) {
      this.reached.resolve(); await this.hold;
      return response({ ...task(JSON.parse(String(init.body)).state), id: this.taskId });
    }
    throw new Error(`UNSUPPORTED ${method} ${url.pathname}`);
  };
}

function profileDir(root: string, name: string, config: Config) {
  const dir = join(root, "concourse-v3", name); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = new PrivateFiles(dir);
  files.write("config.json", config);
  files.write("tokens.json", { access: "synthetic", expires: Date.now() + 3600000, resource: config.origin, clientId: config.oauthClientId, issuer: config.issuer });
  files.close(); return join(dir, "config.json");
}

function session(flag: string, servers: Server[]) {
  const tools = new Map<string, any>(), handlers = new Map<string, any>(); let command: any;
  const sent: { message: any; options: any }[] = [], statuses = new Map<string, string>(), notes: string[] = [];
  const ctx = { sessionManager: { getSessionId: () => "session1" }, ui: { setStatus: (k: string, v: string) => statuses.set(k, v), notify: (m: string) => notes.push(m) } };
  const pi = { registerFlag() {}, getFlag: () => flag, getActiveTools: () => [], registerMessageRenderer() {}, on: (e: string, h: unknown) => handlers.set(e, h), registerCommand: (_n: string, c: unknown) => { command = c; },
    registerTool: (t: { name: string }) => tools.set(t.name, t), sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }) } as unknown as ExtensionAPI;
  const route: Fetch = (input, init) => servers.find(s => new URL(input instanceof Request ? input.url : String(input)).origin === s.config.origin)!.fetch(input, init);
  install(pi, route);
  return { sent, statuses, notes,
    start: () => handlers.get("session_start")({}, ctx) as Promise<void>,
    stop: () => handlers.get("session_shutdown")() as Promise<void>,
    tool: (name: string, p: object) => tools.get(`concourse_v3_${name}`).execute("call", p, undefined, undefined, ctx),
    command: (args: string) => command.handler(args, ctx) as Promise<void> };
}

async function until(done: () => boolean) { for (let i = 0; i < 500 && !done(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(done(), "condition reached"); }

function fixture(t: { after(fn: () => unknown): void }) {
  const root = mkdtempSync(join(tmpdir(), "concourse-v3-multi-")), a = new Server(alpha, "task-a"), b = new Server(beta, "task-b");
  const paths = { a: profileDir(root, "reviews", alpha), b: profileDir(root, "notes", beta) };
  const s = session(`${paths.a},${paths.b}`, [a, b]);
  const ledger = (p: string) => { const files = new PrivateFiles(join(p, "..")); try { return new FileJournal(files).load(); } finally { files.close(); } };
  t.after(async () => { await s.stop(); rmSync(root, { recursive: true, force: true }); });
  return { root, a, b, paths, s, ledger };
}

test("two profiles: mail from each arrives labelled through normal follow-up, with one footer key per profile", async t => {
  const f = fixture(t); await f.s.start();
  await until(() => f.s.sent.length === 2);
  const byProfile = Object.fromEntries(f.s.sent.map(x => [x.message.details.profile, x]));
  assert.match(byProfile["alpha.invalid/owner/reviews"].message.content, /^\[alpha\.invalid · owner\/reviews\] A2A message from[^\n]*task-a/);
  assert.match(byProfile["beta.invalid/writer/notes"].message.content, /^\[beta\.invalid · writer\/notes\] A2A message from[^\n]*task-b/);
  for (const x of f.s.sent) assert.deepEqual(x.options, { triggerTurn: true, deliverAs: "followUp" });
  await until(() => [...f.s.statuses.values()].every(v => v.includes("checked")) && f.s.statuses.size === 2);
  assert.match(f.s.statuses.get("concourse-v3")!, /owner\/reviews @ alpha\.invalid/);
  assert.match(f.s.statuses.get("concourse-v3:2")!, /writer\/notes @ beta\.invalid/);
});

test("two profiles: a reply goes back only to the originating server; a different or missing profile writes nothing", async t => {
  const f = fixture(t); await f.s.start(); await until(() => f.s.sent.length === 2);
  await assert.rejects(f.s.tool("reply", { task_id: "task-b", state: "TASK_STATE_COMPLETED", parts: [{ text: "x" }], profile: "alpha.invalid/owner/reviews" }), /REPLY_PROFILE_MISMATCH/);
  await assert.rejects(f.s.tool("send", { to: "other/peer", parts: [{ text: "x" }] }), /PROFILE_REQUIRED/);
  await assert.rejects(f.s.tool("send", { to: "other/peer", parts: [{ text: "x" }], profile: "elsewhere.invalid/x/y" }), /PROFILE_UNKNOWN/);
  await assert.rejects(f.s.tool("reply", { task_id: "never-received", state: "TASK_STATE_COMPLETED", parts: [{ text: "x" }] }), /PROFILE_REQUIRED/);
  for (const p of [f.paths.a, f.paths.b]) { const l = f.ledger(p); assert.equal(l.replies, undefined); assert.deepEqual(l.outgoing, {}); }
  assert.equal([...f.a.calls, ...f.b.calls].filter(c => c.method !== "GET").length, 0);

  await f.s.tool("reply", { task_id: "task-b", state: "TASK_STATE_COMPLETED", parts: [{ text: "done" }] });
  assert.deepEqual(f.b.calls.filter(c => c.method === "PATCH"), [{ method: "PATCH", path: "/tasks/task-b" }]);
  assert.equal(f.a.calls.filter(c => c.method === "PATCH").length, 0);
  assert.equal(Object.values(f.ledger(f.paths.b).replies!)[0].phase, "accepted");
  assert.equal(f.ledger(f.paths.a).replies, undefined);
});

for (const failure of [401, 503, "disconnect"] as const) {
  test(`failure isolation: a profile ${failure === "disconnect" ? "losing its doorbell" : `returning ${failure}`} does not block the other`, async t => {
    const f = fixture(t);
    if (failure === "disconnect") f.b.doorbell = "drop"; else f.b.failure = failure;
    await f.s.start();
    await until(() => f.s.sent.length === 1);
    assert.equal(f.s.sent[0].message.details.profile, "alpha.invalid/owner/reviews");
    if (failure !== "disconnect") {
      await until(() => /⚠/.test(f.s.statuses.get("concourse-v3:2") ?? ""));
      await f.s.command("refresh");
      assert.ok(f.s.notes.some(n => n.startsWith("[beta.invalid · writer/notes] HTTP_REFUSED")));
      assert.equal(f.s.sent.length, 1);
    } else {
      await f.s.tool("check", { profile: "beta.invalid/writer/notes" });
      await until(() => f.s.sent.length === 2);
    }
    assert.match(f.s.statuses.get("concourse-v3")!, /✓ owner\/reviews/);
  });
}

test("locks: a second session cannot take held profiles; shutdown releases every lock and fences late writes", async t => {
  const f = fixture(t); await f.s.start(); await until(() => f.s.sent.length === 2);
  const other = session(`${f.paths.a},${f.paths.b}`, [f.a, f.b]); await other.start();
  assert.equal(other.notes.length, 2); await assert.rejects(other.tool("check", {}), /V3_NOT_CONNECTED/);

  const hold = deferred<void>(); f.b.hold = hold.promise;
  const reply = f.s.tool("reply", { task_id: "task-b", state: "TASK_STATE_WORKING" }).catch((e: Error) => e);
  await f.b.reached.promise;
  const stopped = f.s.stop(); hold.resolve(); await stopped; await reply;
  assert.equal(Object.values(f.ledger(f.paths.b).replies!)[0].phase, "prepared", "no late write after release");
  for (const p of [f.paths.a, f.paths.b]) { const files = new PrivateFiles(join(p, "..")); files.acquire()(); files.close(); }
});

test("LEGACY staging and subdomains, the default profile and duplicate identities are refused; other profiles still load", async t => {
  const root = mkdtempSync(join(tmpdir(), "concourse-v3-refuse-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const good = new Server(alpha, "task-a");
  const refused = [
    profileDir(root, "staging", { ...alpha, origin: "https://concourse.example.com" }),
    profileDir(root, "default", { ...alpha, agent: "other" }),
    profileDir(root, "staging-subdomain", { ...alpha, origin: "https://nested.concourse.example.com", organization: "legacy", agent: "third" }),
  ];
  const s = session([profileDir(root, "good", alpha), ...refused, profileDir(root, "copy", alpha)].join(","), [good]);
  t.after(() => s.stop());
  await s.start(); await until(() => s.sent.length === 1);
  assert.deepEqual(s.notes, ["LEGACY_PROFILE_REFUSED", "LEGACY_PROFILE_REFUSED", "LEGACY_PROFILE_REFUSED", "DUPLICATE_PROFILE_IDENTITY"]);
  // A lone remaining profile behaves exactly as a single profile: no label, no profile detail.
  assert.match(s.sent[0].message.content, /^A2A message from/); assert.equal(s.sent[0].message.details.profile, undefined);
  for (const p of refused) { const files = new PrivateFiles(join(p, "..")); files.acquire()(); files.close(); }
});

test("fresh V3 known-organization profile receives normal follow-up and replies on its own authenticated route", async t => {
  const root = mkdtempSync(join(tmpdir(), "concourse-v3-team-"));
  const config: Config = { ...base, origin: "https://concourse.krishnan.ca", organization: "legacy", owner: "owner", agent: "operator" };
  const server = new Server(config, "task-team"), path = profileDir(root, "operator", config);
  const s = session(path, [server]);
  t.after(async () => { await s.stop(); rmSync(root, { recursive: true, force: true }); });
  await s.start(); await until(() => s.sent.length === 1);
  assert.deepEqual(s.notes, []);
  assert.deepEqual(s.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
  await until(() => s.statuses.get("concourse-v3")?.includes("✓ owner/operator") === true);
  await s.tool("reply", { task_id: "task-team", state: "TASK_STATE_COMPLETED", parts: [{ text: "synthetic reply" }] });
  assert.deepEqual(server.calls.filter(c => c.method === "PATCH"), [{ method: "PATCH", path: "/tasks/task-team" }]);
});
