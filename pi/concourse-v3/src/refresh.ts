import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./auth.ts";
import { json, safeFetch, SafeError, validOrganizationSlug, type Fetch } from "./http.ts";
import { object, type Identity } from "./types.ts";

// Source-only negotiated protocol. Only the issuer's clock controls its window.
const ISSUER = "https://app.krishnan.ca";
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const RESOURCES = ["https://concourse.krishnan.ca", "https://concourse.krishnan.ca/mcp"];
export const MAX_DISPATCHES = 8;
export const MAX_CONFLICT_RETRIES = 4;
type Dispatch = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Generation = 1 | 2 | 3 | 4;
type ConflictRetries = 0 | 1 | 2 | 3 | 4;
export interface RefreshBinding {
  issuer: string; tokenEndpoint: string; clientId: string; resource: string; scope: "concourse";
  organization: string; owner: string; agent: string;
}
export type VerifiedIdentity = Pick<Identity, "release_line" | "organization" | "owner" | "handle" | "oauth_client_id" | "agent_id">;
export interface RefreshReceipt {
  version: 1; key: string; dispatch: Dispatch; generation: Generation; expires_at: number;
}
export interface RefreshCommit {
  version: 4; id: string; binding: RefreshBinding; parentFingerprint: string; ownerEpoch: string;
  dispatch: Dispatch; generation: Generation; windowExpires: number; identity: VerifiedIdentity;
  accessFingerprint: string; successorFingerprint: string; expires: number;
}
export interface RefreshExchange {
  version: 4; id: string; grant: "refresh_token"; binding: RefreshBinding; parentFingerprint: string;
  ownerEpoch: string; dispatches: Dispatch; conflictRetries: ConflictRetries;
  phase: "dispatch-uncertain" | "retry-eligible" | "conflict" | "processing" | "committing" | "refused" | "locked";
  commit?: RefreshCommit;
}
export interface RecoveryCapability { header: "Idempotency-Key"; dispatch_header: "Concourse-Refresh-Dispatch" }
export const fingerprint = (s: string): string => createHash("sha256").update(s).digest("hex");
export const validBearer = (s: unknown): s is string => typeof s === "string" && s.length <= 16_384 && /^[A-Za-z0-9._~+/-]+=*(?![\s\S])/.test(s);
// RFC 6749 Appendix A.17: opaque refresh-token = 1*VSCHAR, not bearer syntax.
export const validRefresh = (s: unknown): s is string => typeof s === "string" && s.length <= 16_384 && /^[\x20-\x7e]+(?![\s\S])/.test(s);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(v);
const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(v);
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const BINDING_KEYS = ["issuer", "tokenEndpoint", "clientId", "resource", "scope", "organization", "owner", "agent"];
const IDENTITY_KEYS = ["release_line", "organization", "owner", "handle", "oauth_client_id", "agent_id"];
const COMMIT_KEYS = ["version", "id", "binding", "parentFingerprint", "ownerEpoch", "dispatch", "generation", "windowExpires", "identity", "accessFingerprint", "successorFingerprint", "expires"];
const EXCHANGE_KEYS = ["version", "id", "grant", "binding", "parentFingerprint", "ownerEpoch", "dispatches", "conflictRetries", "phase"];
const PHASES = ["dispatch-uncertain", "retry-eligible", "conflict", "processing", "committing", "refused", "locked"];
export const refreshBinding = (c: Config): RefreshBinding => ({ issuer: c.issuer, tokenEndpoint: c.tokenEndpoint, clientId: c.oauthClientId, resource: c.origin, scope: "concourse", organization: c.organization, owner: c.owner, agent: c.agent });
function validBinding(v: unknown): v is RefreshBinding {
  return object(v) && exactKeys(v, BINDING_KEYS) && v.issuer === ISSUER && v.tokenEndpoint === TOKEN_ENDPOINT && typeof v.resource === "string" && RESOURCES.includes(v.resource) && v.scope === "concourse" &&
    typeof v.clientId === "string" && v.clientId.length > 0 && v.clientId.length <= 2048 && !/[\x00-\x20\x7f]/.test(v.clientId) && validOrganizationSlug(v.organization) &&
    [v.owner, v.agent].every(s => typeof s === "string" && /^[a-zA-Z0-9_-]{1,100}(?![\s\S])/.test(s));
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return object(a) && object(b) && exactKeys(a, Object.keys(b)) && Object.keys(a).every(k => equal(a[k], b[k]));
}
function validIdentity(v: unknown, binding: RefreshBinding): v is VerifiedIdentity {
  return object(v) && exactKeys(v, IDENTITY_KEYS) && v.release_line === 3 && v.organization === binding.organization && v.owner === binding.owner && v.handle === binding.agent && v.oauth_client_id === binding.clientId && integer(v.agent_id, 1);
}
function validCommit(v: unknown, j: RefreshExchange): v is RefreshCommit {
  return object(v) && exactKeys(v, COMMIT_KEYS) && v.version === 4 && v.id === j.id && equal(v.binding, j.binding) && v.parentFingerprint === j.parentFingerprint && v.ownerEpoch === j.ownerEpoch &&
    v.dispatch === j.dispatches && integer(v.generation, 1, Math.min(4, j.dispatches)) && integer(v.windowExpires, 1) && validIdentity(v.identity, j.binding) && hash(v.accessFingerprint) && hash(v.successorFingerprint) && integer(v.expires, 1);
}
export function parseExchange(v: unknown, binding: RefreshBinding): RefreshExchange | undefined {
  if (!object(v) || !exactKeys(v, v.phase === "committing" ? [...EXCHANGE_KEYS, "commit"] : EXCHANGE_KEYS) || v.version !== 4 || !uuid(v.id) || v.grant !== "refresh_token" || !validBinding(binding) || !validBinding(v.binding) || !equal(v.binding, binding) || !hash(v.parentFingerprint) || !uuid(v.ownerEpoch) || !integer(v.dispatches, 1, MAX_DISPATCHES) || !integer(v.conflictRetries, 0, MAX_CONFLICT_RETRIES) || v.conflictRetries >= v.dispatches || !PHASES.includes(v.phase as string)) return;
  const j = v as unknown as RefreshExchange;
  if (j.phase === "committing" && !validCommit(j.commit, j)) return;
  return j;
}
function validExchange(j: unknown): j is RefreshExchange {
  return object(j) && validBinding(j.binding) && parseExchange(j, j.binding) !== undefined;
}
export function sameExchange(a: unknown, b: unknown): boolean {
  return validExchange(a) && validExchange(b) && equal(a, b);
}
// Reservations are never refunded, including a crash before the HTTP call.
export const resumable = (j: RefreshExchange): boolean => validExchange(j) && ["dispatch-uncertain", "retry-eligible", "conflict"].includes(j.phase) && j.dispatches < MAX_DISPATCHES && (j.phase !== "conflict" || j.conflictRetries < MAX_CONFLICT_RETRIES);
export function newExchange(binding: RefreshBinding, parent: string, ownerEpoch: string): RefreshExchange {
  if (!validBinding(binding) || !validRefresh(parent) || !uuid(ownerEpoch)) throw new SafeError("INVALID_REFRESH_EXCHANGE");
  return { version: 4, id: randomUUID(), grant: "refresh_token", binding: { ...binding }, parentFingerprint: fingerprint(parent), ownerEpoch, dispatches: 1, conflictRetries: 0, phase: "dispatch-uncertain" };
}
export function reserveDispatch(j: RefreshExchange, ownerEpoch: string): RefreshExchange {
  if (!resumable(j)) throw new SafeError("OAUTH_EXCHANGE_UNCERTAIN", true);
  if (!uuid(ownerEpoch)) throw new SafeError("INVALID_REFRESH_EXCHANGE");
  // A later transport-loss retry must not count the same 409 twice.
  return { ...j, binding: { ...j.binding }, ownerEpoch, dispatches: (j.dispatches + 1) as Dispatch, conflictRetries: (j.conflictRetries + (j.phase === "conflict" ? 1 : 0)) as ConflictRetries, phase: "dispatch-uncertain" };
}
export function markRequest(cap: RecoveryCapability, j: RefreshExchange, _form: URLSearchParams, headers: Record<string, string>): void {
  if (!object(cap) || !exactKeys(cap, ["header", "dispatch_header"]) || cap.header !== "Idempotency-Key" || cap.dispatch_header !== "Concourse-Refresh-Dispatch" || !validExchange(j)) throw new SafeError("INVALID_REFRESH_EXCHANGE");
  for (const key of Object.keys(headers)) if (["idempotency-key", "concourse-refresh-dispatch"].includes(key.toLowerCase())) delete headers[key];
  headers[cap.header] = `"${j.id}"`;
  headers[cap.dispatch_header] = String(j.dispatches);
}
function validReceipt(v: unknown, j: RefreshExchange): v is RefreshReceipt {
  return object(v) && exactKeys(v, ["version", "key", "dispatch", "generation", "expires_at"]) && v.version === 1 && v.key === j.id && v.dispatch === j.dispatches && integer(v.generation, 1, Math.min(4, j.dispatches)) && integer(v.expires_at, 1);
}
export function responseReceipt(body: Record<string, unknown>, j: RefreshExchange): RefreshReceipt {
  const receipt: unknown = object(body) ? body.concourse_refresh_idempotency : undefined;
  if (!validExchange(j) || !validReceipt(receipt, j)) throw new SafeError("INVALID_REFRESH_EXCHANGE_RESPONSE");
  return { ...receipt };
}
export function commitReceipt(j: RefreshExchange, receipt: RefreshReceipt, identity: Identity | VerifiedIdentity, access: string, refresh: string, expires: number): RefreshCommit {
  if (!validExchange(j) || !validReceipt(receipt, j) || !object(identity) || !validBearer(access) || !validRefresh(refresh) || !integer(expires, 1)) throw new SafeError("INVALID_REFRESH_EXCHANGE_RESPONSE");
  // Pick only verified binding fields, never network-agent metadata or secrets.
  const verified: VerifiedIdentity = { release_line: identity.release_line, organization: identity.organization, owner: identity.owner, handle: identity.handle, oauth_client_id: identity.oauth_client_id, agent_id: identity.agent_id };
  if (!validIdentity(verified, j.binding)) throw new SafeError("INVALID_REFRESH_EXCHANGE_RESPONSE");
  return { version: 4, id: j.id, binding: { ...j.binding }, parentFingerprint: j.parentFingerprint, ownerEpoch: j.ownerEpoch, dispatch: receipt.dispatch, generation: receipt.generation, windowExpires: receipt.expires_at, identity: verified, accessFingerprint: fingerprint(access), successorFingerprint: fingerprint(refresh), expires };
}
export function committed(j: RefreshExchange, receipt: unknown, t: { access: string; refresh?: string; expires: number }): boolean {
  // A processing phase alone proves nothing. The durable expected receipt must
  // equal the one atomically stored with the tokens, even after access expiry.
  return validExchange(j) && j.phase === "committing" && validCommit(receipt, j) && equal(j.commit, receipt) && object(t) && validBearer(t.access) && validRefresh(t.refresh) && integer(t.expires, 1) && receipt.accessFingerprint === fingerprint(t.access) && receipt.successorFingerprint === fingerprint(t.refresh) && receipt.expires === t.expires;
}
export async function validatedConflict(response: Response, j: RefreshExchange): Promise<void> {
  try {
    const media = response.headers.get("content-type") ?? "";
    const noStore = (response.headers.get("cache-control") ?? "").split(",").some(s => s.trim().toLowerCase() === "no-store");
    if (!validExchange(j) || response.status !== 409 || response.redirected || (response.url && response.url !== j.binding.tokenEndpoint) || !/^application\/problem\+json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(media) || !noStore || response.headers.get("retry-after") !== "1") throw new Error();
    const b = await json(response);
    if (!object(b) || !exactKeys(b, ["type", "title", "status", "error", "concourse_refresh_idempotency"]) || b.type !== "urn:ajent:oauth:refresh-idempotency-in-progress" || typeof b.title !== "string" || b.status !== 409 || b.error !== "concourse_refresh_in_progress") throw new Error();
    const m = b.concourse_refresh_idempotency;
    if (!object(m) || !exactKeys(m, ["version", "key", "dispatch"]) || m.version !== 1 || m.key !== j.id || m.dispatch !== j.dispatches) throw new Error();
  } catch { throw new SafeError("INVALID_REFRESH_CONFLICT", false, 409); }
}

// Discovery failures may downgrade only a NEW grant. Ownership checks stay out
// of the narrow catch; the caller fences any unresolved saved operation.
export async function supportsRecovery(c: Config, fetchImpl: Fetch, guard: () => void): Promise<RecoveryCapability | undefined> {
  guard();
  if (c.issuer !== ISSUER || c.tokenEndpoint !== TOKEN_ENDPOINT || !RESOURCES.includes(c.origin)) return;
  let r: Response;
  try { r = await safeFetch(ISSUER, fetchImpl)(`${ISSUER}/.well-known/oauth-authorization-server`, { method: "GET", headers: { accept: "application/json" } }); }
  catch (e) {
    guard();
    if (!(e instanceof SafeError) || !(["TRANSPORT_FAILED", "REDIRECT_REFUSED", "HEADERS_TOO_LARGE", "RESPONSE_TOO_LARGE"].includes(e.code) || /^HTTP_REFUSED_\d{3}$/.test(e.code))) throw e;
    return;
  }
  guard();
  let b: unknown;
  try { b = await json(r); } catch (e) { guard(); if (e instanceof SafeError && e.code === "INVALID_JSON") return; throw e; }
  guard();
  if (!object(b) || b.issuer !== ISSUER || b.token_endpoint !== TOKEN_ENDPOINT || Object.hasOwn(b, "concourse_refresh_recovery") || Object.hasOwn(b, "concourse_refresh_recovery_v3") || !object(b.concourse_refresh_idempotency)) return;
  const m = b.concourse_refresh_idempotency;
  const exact = exactKeys(m, ["version", "header", "key_format", "dispatch_header", "window_seconds", "max_dispatches_per_exchange", "max_reissues", "max_conflict_retries", "mode", "successor_consumption", "late_request_behavior", "scope", "resources"]) && m.version === 1 && m.header === "Idempotency-Key" && m.key_format === "sf-string-uuid-v4" && m.dispatch_header === "Concourse-Refresh-Dispatch" && m.window_seconds === 86_400 && m.max_dispatches_per_exchange === MAX_DISPATCHES && m.max_reissues === 3 && m.max_conflict_retries === MAX_CONFLICT_RETRIES && m.mode === "replace_unconsumed_successor" && m.successor_consumption === "refresh_token_rotation" && m.late_request_behavior === "reject_without_family_revocation" && m.scope === "concourse" && Array.isArray(m.resources) && m.resources.length === RESOURCES.length && RESOURCES.every(r => (m.resources as unknown[]).filter(v => v === r).length === 1);
  return exact ? { header: "Idempotency-Key", dispatch_header: "Concourse-Refresh-Dispatch" } : undefined;
}
