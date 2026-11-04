import assert from "node:assert/strict";
import { mock } from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { config, identity, task, deferred, response } from "./helpers.ts";
const baseConfig = config, baseIdentity = identity;
import type { Fetch } from "../src/http.ts";
import type { Task } from "../src/types.ts";

export { config, identity, task, deferred, response };
export const syntheticToken = "sdk-fixture-token-not-a-credential";
export const endpoint = (recipient = "other/sender") => `${config.origin}/a2a/${config.organization}/${recipient}`;
// A2A v1.0 §8.3/§7.3, candidate app/models/a2a/card.rb's protobuf JSON security shape.
export function card(recipient = "other/sender") {
  return { name: recipient, description: "Synthetic SDK peer", version: "1.0.0",
    supportedInterfaces: [{ url: endpoint(recipient), protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: true },
    securitySchemes: { oauth2: { oauth2SecurityScheme: { description: "Synthetic OAuth only", flows: { authorizationCode: { authorizationUrl: `${config.issuer}/oauth/authorize`, tokenUrl: config.tokenEndpoint, scopes: { concourse: "Call synthetic peers" }, pkceRequired: true } }, oauth2MetadataUrl: `${config.issuer}/.well-known/oauth-authorization-server` } } },
    securityRequirements: [{ schemes: { oauth2: { list: ["concourse"] } } }],
    defaultInputModes: ["text/plain", "application/json"], defaultOutputModes: ["text/plain", "application/json"], skills: [] };
}

// No fallback to captured real fetch. Socket/HTTP/DNS entry points fail before I/O.
// The counter measures attempted forbidden outbound calls, not merely completed traffic.
export function outboundGuard(fixtureFetch?: Fetch) {
  let forbidden = 0;
  const refuse = () => { forbidden++; throw new Error("FORBIDDEN_REAL_OUTBOUND"); };
  const mocks = [mock.method(globalThis, "fetch", fixtureFetch ?? refuse),
    mock.method(http, "request", refuse), mock.method(http, "get", refuse),
    mock.method(https, "request", refuse), mock.method(https, "get", refuse),
    mock.method(net, "connect", refuse), mock.method(net, "createConnection", refuse),
    mock.method(net.Socket.prototype, "connect", refuse), mock.method(tls, "connect", refuse),
    mock.method(dns, "lookup", refuse), mock.method(dns.promises, "lookup", refuse)];
  return { get forbidden() { return forbidden; }, close() { for (const fn of mocks.reverse()) fn.mock.restore(); assert.equal(forbidden, 0, "no real outbound entry point attempted"); } };
}

export interface Captured { url: string; method: string; headers: Headers; body?: any }
export class WireFixture {
  // A second server for multi-profile tests differs only by origin/agent; card and A2A paths stay first-server only.
  constructor(readonly config = baseConfig, readonly identity = { ...baseIdentity, handle: config.agent }) {}
  calls: Captured[] = [];
  inbox: Task[] = [task()];
  current = task();
  phases = new Map<string, { id: string; phase: string; messageIds: string[]; sessionId: string }>();
  operationGates = new Map<string, ReturnType<typeof deferred<void>>>();
  reached = new Map<string, ReturnType<typeof deferred<void>>>();
  connectionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  sessionId?: string;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  unsupported = 0;
  cardOverride?: ReturnType<typeof card>;
  cardResponse?: Response;
  rpcResult: unknown = { task: task() };
  rpcFailure?: "lost" | "500" | "401" | "bad-id";
  pageTokens: string[] = [];
  inboxFailureOnce?: number;
  inboxTailFailure?: number;
  signal(operation: string) { let d = this.reached.get(operation); if (!d) { d = deferred<void>(); this.reached.set(operation, d); } return d; }
  hold(operation: string) { const d = deferred<void>(); this.operationGates.set(operation, d); return d; }
  ping() { this.stream?.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n")); }
  close() { try { this.stream?.close(); } catch {} this.stream = undefined; }
  fetch: Fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase(), headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { url: url.href, method, headers, body }; this.calls.push(call);
    assert.equal(init.redirect, "error", "all fixture HTTP refuses redirects");
    assert.equal(url.origin, this.config.origin, "fixture has no issuer/model/network fallback");
    assert.equal(headers.get("authorization"), `Bearer ${syntheticToken}`);
    if (method === "GET" && url.pathname === "/api/identity") return response(this.identity);
    if (method === "GET" && url.pathname === "/api/doorbell") {
      this.sessionId = headers.get("Concourse-Session-Id")!; assert.ok(this.sessionId);
      const stream = new ReadableStream<Uint8Array>({ start: controller => {
        this.stream = controller;
        controller.enqueue(new TextEncoder().encode(`event: ready\ndata: ${JSON.stringify({ release_line: 3, connectionId: this.connectionId, sessionId: this.sessionId })}\n\n`));
        init.signal?.addEventListener("abort", () => this.close(), { once: true });
      }, cancel: () => { this.stream = undefined; } });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (method === "GET" && url.pathname === `/agents/${this.identity.agent_id}/tasks`) {
      assert.equal(url.searchParams.get("pageSize"), "50");
      const token = url.searchParams.get("pageToken") ?? ""; this.pageTokens.push(token);
      assert.ok(["", "sdk-page-2"].includes(token));
      // Snapshot before a deterministic I/O gate: a coalesced caller must await its newer read.
      const snapshot = structuredClone(token ? [] : this.inbox), failure = this.inboxFailureOnce; this.inboxFailureOnce = undefined;
      this.signal("inbox").resolve(); await this.operationGates.get("inbox")?.promise;
      if (failure) return response({}, failure);
      if (token && this.inboxTailFailure) return response({}, this.inboxTailFailure);
      return response({ tasks: snapshot, nextPageToken: token ? "" : "sdk-page-2", pageSize: 50 });
    }
    if (method === "GET" && url.pathname === `/api/tasks/${this.current.id}`) return response(this.current);
    if (method === "GET" && url.pathname === "/api/tasks") return response({ tasks: [this.current], nextPageToken: "", pageSize: 50 });
    if (method === "GET" && url.pathname === "/agents") return response({ agents: [{ qualified_handle: "other/sender", description: "Decisive synthetic directory content" }] });
    if (method === "PATCH" && url.pathname === `/tasks/${this.current.id}`) {
      if (!body.delivery) {
        this.signal("reply").resolve(); await this.operationGates.get("reply")?.promise;
        assert.ok(["TASK_STATE_WORKING", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_REJECTED"].includes(body.state));
        this.current.status.state = body.state;
        if (body.message) { this.current.status.message = { messageId: "server-reply-id", role: "ROLE_AGENT", parts: body.message.parts }; this.current.history!.push(this.current.status.message); }
        if (body.artifacts) this.current.artifacts = body.artifacts.map((a: object, i: number) => ({ ...a, artifactId: `server-art-${i}` }));
        this.signal("reply:confirmed").resolve(); return response(this.current);
      }
      const d = body.delivery;
      assert.equal(d.connectionId, this.connectionId); assert.equal(d.sessionId, this.sessionId);
      this.signal(d.operation).resolve(); await this.operationGates.get(d.operation)?.promise;
      let claim = this.phases.get(d.id);
      if (d.operation === "accept") {
        assert.deepEqual(d.messageIds, ["m1"]); assert.equal(Object.keys(body).length, 1);
        claim ??= { id: d.id, phase: "queued", messageIds: d.messageIds, sessionId: d.sessionId }; this.phases.set(d.id, claim);
      } else {
        assert.ok(claim, "no claim operation without prior accept");
        if (["prompt", "start", "resume", "uncertain"].includes(d.operation)) assert.deepEqual(Object.keys(body), ["delivery"], "start derives WORKING; no supplied state");
        const phases: Record<string, string> = { prompt: "prompting", start: "running", uncertain: "uncertain", settle: "settled" };
        if (d.operation !== "resume") { assert.ok(phases[d.operation], "supported PATCH operation required"); claim.phase = phases[d.operation]; }
        if (d.operation === "start") this.current.status.state = "TASK_STATE_WORKING";
        if (d.operation === "settle") {
          assert.notEqual(body.state, "TASK_STATE_CANCELED");
          if (body.state) this.current.status.state = body.state;
          if (body.message) {
            this.current.status.message = { messageId: "server-reply-id", role: "ROLE_AGENT", parts: body.message.parts };
            this.current.history!.push(this.current.status.message);
          }
          assert.ok(!(body.artifact && body.artifacts));
          const artifacts = body.artifacts ?? (body.artifact ? [body.artifact] : []);
          this.current.artifacts = artifacts.map((a: unknown, i: number) => ({ ...(a as object), artifactId: `server-art-${i}` }));
        }
      }
      this.signal(`${d.operation}:confirmed`).resolve();
      return response({ ...this.current, delivery: claim });
    }
    if (method === "GET" && /^\/a2a\/test\/(other\/sender|concourse\/network-1)\/\.well-known\/agent-card\.json$/.test(url.pathname)) {
      assert.equal(headers.get("A2A-Version"), "1.0");
      return this.cardResponse?.clone() ?? response(this.cardOverride ?? card(url.pathname.includes("network-1") ? "concourse/network-1" : "other/sender"));
    }
    if (method === "POST" && [endpoint(), endpoint("concourse/network-1")].includes(url.href)) {
      assert.equal(headers.get("A2A-Version"), "1.0"); assert.equal(body.jsonrpc, "2.0"); assert.equal(body.method, "SendMessage");
      assert.equal(body.params.configuration.returnImmediately, true);
      if (this.rpcFailure === "lost") throw new Error("synthetic response lost after accepted write");
      if (this.rpcFailure === "500" || this.rpcFailure === "401") return response({}, Number(this.rpcFailure));
      const result = url.href.includes("network-1") ? { message: { messageId: "network-answer", contextId: "network-context", role: "ROLE_AGENT", parts: [{ mediaType: "application/json", data: { operation: body.params.message.parts[0].data.operation, agent: "other/sender", state: "connected", observedAt: null, leaseExpiresAt: null, fresh: false } }] } } : this.rpcResult;
      return response({ jsonrpc: "2.0", id: this.rpcFailure === "bad-id" ? "wrong-id" : body.id, result });
    }
    this.unsupported++; throw new Error(`UNSUPPORTED_SYNTHETIC_HTTP ${method} ${url.pathname}`);
  };
}
