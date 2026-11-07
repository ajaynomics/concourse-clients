import type { SendMessageRequest } from "@a2a-js/sdk";
import type { Config } from "./auth.ts";
import { json, safeFetch, SafeError, type Fetch } from "./http.ts";
import { object, task, type Identity, type Json, type ObjectValue, type Outcome, type Task } from "./types.ts";

export const RECIPIENT_PATTERN = "^[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$";
// Checked before any send intent is journaled: a locally refused send was certainly never sent.
export function qualifiedRecipient(recipient: string): string {
  if (!new RegExp(RECIPIENT_PATTERN).test(recipient)) throw new SafeError("QUALIFIED_RECIPIENT_REQUIRED: use owner/agent, not a URL");
  return recipient;
}
// Concourse Task IDs are UUIDs. A shortened ID can only miss or name another Task.
export function fullTaskId(id: string): string {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new SafeError("FULL_TASK_ID_REQUIRED", false, undefined, {}, "Use the task's full ID exactly as shown, for example 123e4567-e89b-42d3-a456-426614174000, not a shortened one.");
  return id;
}
export const TASK_FINISHED_HINT = "That task is finished. Send a new message without task_id to start a new task.";
// A2A v1.0 §9.5: a well-formed JSON-RPC error answering OUR request id is a definite
// refusal only for codes Concourse raises before it saves anything (§5.4 table).
// -32603, unknown codes and any error naming a task/delivery (RELAY_WAIT_LIMIT,
// RELAY_DELIVERY_*) can follow a committed write, so they stay uncertain.
// -32001 (task not found) is a refusal too: Concourse raises it after a save only while a
// blocking send waits for the task to settle, and this client always asks to return at once.
const PRE_COMMIT_CODES = new Set([-32700, -32600, -32601, -32602, -32001, -32002, -32003, -32004, -32005, -32009]);
// Concourse's own detail follows the spec's ErrorInfo under this fixed domain.
const CONCOURSE_DOMAIN = "concourse.krishnan.ca";
const errorInfo = (d: unknown): d is ObjectValue => object(d) && d["@type"] === "type.googleapis.com/google.rpc.ErrorInfo";
const reasonName = (v: unknown) => typeof v === "string" && /^[A-Z][A-Z0-9_]{0,62}$/.test(v) ? v : undefined;
// Only the numeric code and ErrorInfo reasons are kept, never server text.
export function rpcRefusal(rpc: { id: unknown; body: unknown } | undefined, code: string, hint?: string): SafeError | undefined {
  if (!rpc || (typeof rpc.id !== "string" && typeof rpc.id !== "number")) return;
  const b = rpc.body;
  if (!object(b) || b.jsonrpc !== "2.0" || b.id !== rpc.id || "result" in b || !object(b.error) || !Number.isSafeInteger(b.error.code) || typeof b.error.message !== "string") return;
  if (!PRE_COMMIT_CODES.has(b.error.code as number)) return;
  const infos = Array.isArray(b.error.data) ? b.error.data.filter(errorInfo) : [];
  if (infos.some(i => object(i.metadata) && ("taskId" in i.metadata || "deliveryId" in i.metadata))) return;
  const own = infos.find(i => i.domain === CONCOURSE_DOMAIN && reasonName(i.reason));
  const reason = reasonName(own?.reason) ?? reasonName(infos[0]?.reason);
  return new SafeError(code, false, undefined, { rpcCode: b.error.code as number, ...(reason ? { reason } : {}) }, hint);
}
export function wireParts(parts: ObjectValue[]) {
  return parts.map(p => {
    if (typeof p.text === "string") return { content: { $case: "text" as const, value: p.text }, metadata: undefined, filename: "", mediaType: "text/plain" };
    if (object(p.data)) return { content: { $case: "data" as const, value: p.data }, metadata: undefined, filename: "", mediaType: "application/json" };
    throw new SafeError("UNSUPPORTED_OUTBOUND_PART: use {text} or {data}");
  });
}

// Checked before a reply intent is journaled: an invalid outcome was certainly never written.
export function validOutcome(outcome: Outcome): Outcome {
  if (!["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_REJECTED", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_WORKING"].includes(outcome.state)) throw new SafeError("INVALID_REPLY_STATE");
  if ((outcome.artifacts?.length ?? 0) > 20) throw new SafeError("ARTIFACT_BATCH_LIMIT");
  if (outcome.state === "TASK_STATE_INPUT_REQUIRED" && !outcome.parts?.length) throw new SafeError("QUESTION_CONTENT_REQUIRED");
  return outcome;
}

// Distinguish a failed Task GET from the identity read required before it.
export class TaskReadError extends SafeError {
  constructor(error: SafeError) { super(error.code, error.uncertain, error.status, error.details, error.hint); }
}
export class InboxReadError extends SafeError {
  constructor(error: SafeError) { super(error.code, error.uncertain, error.status, error.details, error.hint); }
}

export class Client {
  readonly fetch: Fetch;
  constructor(readonly config: Config, private getToken: () => Promise<string>, fetchImpl: Fetch = fetch, private alive: () => boolean = () => true, private observeIdentity: (event: { state: "attempt" } | { state: "success" } | { state: "failure"; error: unknown }) => void = () => {}) { this.fetch = safeFetch(config.origin, fetchImpl); }
  private check(): void { if (!this.alive()) throw new SafeError("SESSION_REPLACED"); }
  async request(method: string, path: string, body?: unknown, guard?: () => void): Promise<unknown> {
    this.check(); guard?.();
    const token = await this.getToken();
    this.check(); guard?.();
    const r = await this.fetch(`${this.config.origin}/${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    this.check(); guard?.(); const value = await json(r); this.check(); guard?.(); return value;
  }
  async identity(): Promise<Identity> {
    this.check(); this.observeIdentity({ state: "attempt" });
    let value: Identity;
    try {
      const b = await this.request("GET", "api/identity");
      const c = this.config;
      if (!object(b) || b.release_line !== 3 || b.organization !== c.organization || b.owner !== c.owner || b.handle !== c.agent || b.oauth_client_id !== c.oauthClientId || typeof b.agent_id !== "number" || !Number.isInteger(b.agent_id) || typeof b.network_agent !== "string" || !/^concourse\/network-[a-zA-Z0-9_-]+$/.test(b.network_agent)) throw new SafeError("V3_IDENTITY_REFUSED");
      this.check(); value = b as unknown as Identity;
    } catch (error) { this.observeIdentity({ state: "failure", error }); throw error; }
    // Observation failures are local failures, outside transport/write classification.
    this.observeIdentity({ state: "success" }); return value;
  }
  async reply(id: string, outcome: Outcome, guard?: () => void): Promise<Task> {
    validOutcome(outcome); await this.identity(); this.check(); guard?.();
    const value = task(await this.request("PATCH", `tasks/${encodeURIComponent(id)}`, {
      state: outcome.state,
      ...(outcome.parts?.length ? { message: { parts: outcome.parts } } : {}),
      ...(outcome.artifacts?.length ? { artifacts: outcome.artifacts } : {}),
    }, guard));
    if (value.id !== id) throw new SafeError("WRONG_REPLY_TASK", true);
    return value;
  }
  async get(id: string): Promise<Task> {
    // Failed identity reads are never per-Task absence/content diagnostics.
    try { await this.identity(); } catch (e) {
      if (e instanceof SafeError && (e.status === 404 || e.code === "RESPONSE_TOO_LARGE")) throw new SafeError("V3_IDENTITY_REFUSED");
      throw e;
    }
    try {
      const value = task(await this.request("GET", `api/tasks/${encodeURIComponent(id)}`));
      if (value.id !== id) throw new SafeError("WRONG_READ_TASK");
      return value;
    } catch (e) {
      if (e instanceof SafeError) throw new TaskReadError(e);
      throw e;
    }
  }
  async list(filters: Record<string, string | number | boolean> = {}): Promise<{ tasks: Task[]; nextPageToken?: string; [key: string]: unknown }> {
    await this.identity();
    const q = new URLSearchParams(Object.entries({ ...filters, pageSize: 50 }).map(([k, v]) => [k, String(v)]));
    const b = await this.request("GET", `api/tasks?${q}`);
    if (!object(b) || !Array.isArray(b.tasks) || b.tasks.length > 50) throw new SafeError("INVALID_TASK_PAGE");
    return { ...b, tasks: b.tasks.map(task), ...(typeof b.nextPageToken === "string" && b.nextPageToken ? { nextPageToken: b.nextPageToken } : {}) };
  }
  async inbox(cursor?: string): Promise<{ tasks: Task[]; nextPageToken?: string; blockedTasks: { taskId: string; code: string }[] }> {
    const identity = await this.identity();
    const b = await this.request("GET", `agents/${identity.agent_id}/tasks?${new URLSearchParams({ pageSize: "50", ...(cursor ? { pageToken: cursor } : {}) })}`).catch(e => {
      if (e instanceof SafeError) throw new InboxReadError(e);
      throw e;
    });
    // A bare {tasks} is the legacy unpaged inbox: never pretend ignored cursors work.
    if (!object(b) || !Array.isArray(b.tasks) || b.tasks.length > 50 || typeof b.nextPageToken !== "string") throw new SafeError("V3_BOUNDED_INBOX_CONTRACT_REQUIRED");
    const blocked = b.blockedTasks ?? [];
    if (!Array.isArray(blocked) || blocked.length > 50 || blocked.some(v => !object(v) || typeof v.taskId !== "string" || !v.taskId || v.taskId.length > 2048 || v.code !== "INBOX_TASK_TOO_LARGE")) throw new SafeError("INVALID_INBOX_DIAGNOSTIC");
    return { tasks: b.tasks.map(task), blockedTasks: blocked as { taskId: string; code: string }[], ...(b.nextPageToken ? { nextPageToken: b.nextPageToken } : {}) };
  }
  async find(query?: string): Promise<unknown> { await this.identity(); return this.request("GET", `agents?${new URLSearchParams(query ? { query } : {})}`); }
  // A2A v1.0 §3.1.1/§3.3.1: one attempt; any resend is the Outbox's, with the same messageId. Message stays Message.
  async send(recipient: string, messageId: string, parts: ObjectValue[], taskId?: string, contextId?: string): Promise<Json> {
    qualifiedRecipient(recipient); const outbound = wireParts(parts);
    const { Role } = await import("@a2a-js/sdk");
    await this.identity();
    const { client, wire } = await this.connect(recipient);
    const request: SendMessageRequest = { tenant: "", metadata: undefined, configuration: { returnImmediately: true, historyLength: 0, acceptedOutputModes: ["text/plain", "application/json"], taskPushNotificationConfig: undefined }, message: { messageId, taskId: taskId ?? "", contextId: contextId ?? "", role: Role.ROLE_USER, metadata: undefined, extensions: [], referenceTaskIds: [], parts: outbound } };
    try { await client.sendMessage(request); this.check(); } catch (e) { if (e instanceof SafeError) throw e; throw rpcRefusal(wire.rpc(), "A2A_REFUSED") ?? new SafeError("A2A_SEND_UNCONFIRMED", true); }
    this.check(); const result = wire();
    if (!object(result)) throw new SafeError("INVALID_A2A_RESPONSE", true);
    if (object(result.task)) return result.task;
    if (object(result.message)) return result.message;
    throw new SafeError("INVALID_A2A_RESPONSE", true);
  }
  async cancel(recipient: string, id: string): Promise<Json> {
    await this.identity(); const { client, wire } = await this.connect(recipient);
    try { await client.cancelTask({ tenant: "", id, metadata: undefined }); } catch (e) { if (e instanceof SafeError) throw e; throw rpcRefusal(wire.rpc(), "CANCEL_REFUSED", "The server refused to cancel it, so the task was not changed.") ?? new SafeError("A2A_CANCEL_REFUSED_OR_UNKNOWN", true); }
    // A2A §3.1.5 returns the requested Task's updated state, not proof of completed cancellation.
    let value: Task;
    try { value = task(wire()); } catch { throw new SafeError("INVALID_CANCEL_RESPONSE", true); }
    if (value.id !== id) throw new SafeError("WRONG_CANCEL_TASK", true);
    return value as unknown as Json;
  }
  async network(data: ObjectValue): Promise<Json> {
    const identity = await this.identity();
    const result = await this.send(identity.network_agent, crypto.randomUUID(), [{ data }]);
    if (!object(result) || !Array.isArray(result.parts)) throw new SafeError("NETWORK_MESSAGE_REQUIRED");
    const p = result.parts.find(p => object(p) && object(p.data));
    if (!object(p) || !object(p.data)) throw new SafeError("NETWORK_DATA_REQUIRED");
    return p.data;
  }
  private async connect(recipient: string) {
    qualifiedRecipient(recipient);
    // CLI help/install share validation code before npm dependencies exist.
    const { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } = await import("@a2a-js/sdk/client");
    const base = `${this.config.origin}/a2a/${[this.config.organization, ...recipient.split("/")].map(encodeURIComponent).join("/")}`;
    let wire: unknown, rpc: { id: unknown; body: unknown } | undefined;
    const authFetch: Fetch = async (url, init = {}) => {
      this.check(); const token = await this.getToken(); this.check();
      // Never follow an arbitrary card-selected path with this bearer, even on the same host.
      const u = new URL(url instanceof Request ? url.url : String(url));
      if (![base, `${base}/`, `${base}/.well-known/agent-card.json`].includes(u.href)) throw new SafeError("A2A_CARD_DESTINATION_REFUSED");
      const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${token}`);
      const r = await this.fetch(url, { ...init, headers }); this.check();
      if (init.method?.toUpperCase() === "POST") {
        const b = await json(r.clone()); this.check(); if (object(b)) wire = b.result;
        let id: unknown; try { id = JSON.parse(String(init.body)).id; } catch { /* no id: never a matching error response */ }
        rpc = { id, body: b };
      }
      return r;
    };
    const resolver = new DefaultAgentCardResolver({ fetchImpl: authFetch });
    const card = await resolver.resolve(`${base}/`); this.check();
    if (!card.supportedInterfaces.length || card.supportedInterfaces.some(i => i.protocolVersion !== "1.0" || i.protocolBinding !== "JSONRPC" || ![base, `${base}/`].includes(i.url))) throw new SafeError("A2A_CARD_VERSION_OR_DESTINATION_REFUSED");
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })], clientConfig: { polling: true }, cardResolver: resolver, preferredTransports: ["JSONRPC"] }).createFromAgentCard(card);
    this.check(); return { client, wire: Object.assign(() => wire, { rpc: () => rpc }) };
  }
}