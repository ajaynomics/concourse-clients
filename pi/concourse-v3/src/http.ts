export type Fetch = typeof fetch;
export type ErrorDetails = Record<string, string | number>;
// Codes stay machine-stable; details carry IDs/status and the hint is plain recovery text.
export class SafeError extends Error {
  constructor(public readonly code: string, public readonly uncertain = false, public readonly status?: number, public readonly details: ErrorDetails = {}, public readonly hint?: string) {
    super(`${code}${Object.entries(details).map(([k, v]) => ` ${k}=${v}`).join("")}${uncertain ? "; outcome unknown: reconcile original IDs; do not resend" : ""}${hint ? `. ${hint}` : ""}`);
  }
}
export function httpsUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SafeError("INVALID_HTTPS_DESTINATION"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new SafeError("INVALID_HTTPS_DESTINATION");
  return url;
}
export async function boundedBytes(response: Response, limit = 1024 * 1024): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body?.cancel(); throw new SafeError("RESPONSE_TOO_LARGE"); }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new SafeError("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
export function safeFetch(origin: string, fetchImpl: Fetch = fetch): Fetch { return boundedFetch(origin, fetchImpl); }
// Only marked refresh dispatches may inspect a 409 body; other refusals remain opaque.
export function refreshFetch(endpoint: string, fetchImpl: Fetch = fetch): Fetch {
  const url = httpsUrl(endpoint); return boundedFetch(url.origin, fetchImpl, false, url.href);
}
function boundedFetch(origin: string, fetchImpl: Fetch, identityErrors = false, refreshEndpoint?: string): Fetch {
  const expected = httpsUrl(origin).origin;
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" || url.origin !== expected || url.username || url.password || url.hash) throw new SafeError("DESTINATION_REFUSED");
    const write = !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase());
    if (typeof init.body === "string" && Buffer.byteLength(init.body) > 512 * 1024) throw new SafeError("REQUEST_TOO_LARGE");
    const deadline = AbortSignal.timeout(15_000);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    let responseStatus: number | undefined;
    try {
      const refreshResponse = refreshEndpoint !== undefined && url.href === refreshEndpoint && init.method === "POST";
      // Native fetch hides 3xx as transport errors in error mode. Expose their
      // status without following them, so a refusal cannot authorize a retry.
      const response = await fetchImpl(url, { ...init, signal, redirect: refreshResponse ? "manual" : "error" });
      responseStatus = response.status;
      if (response.redirected || (response.url && new URL(response.url).origin !== expected) || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => {}); throw new SafeError("REDIRECT_REFUSED", write);
      }
      if (refreshResponse && response.url && response.url !== refreshEndpoint) throw new SafeError("DESTINATION_REFUSED", write);
      let headerBytes = 0; response.headers.forEach((v, k) => { headerBytes += Buffer.byteLength(k) + Buffer.byteLength(v); });
      if (headerBytes > 16 * 1024) { await response.body?.cancel(); throw new SafeError("HEADERS_TOO_LARGE", write); }
      // Error bodies are unneeded and untrusted; keep auth/service status even if their content is oversized.
      const refreshConflict = refreshResponse && response.status === 409;
      if (!response.ok && !refreshConflict && !(identityErrors && init.method === "GET" && url.pathname === "/api/identity" && !url.search && [403, 409].includes(response.status))) {
        await response.body?.cancel().catch(() => {});
        throw new SafeError(`HTTP_REFUSED_${response.status}`, write && response.status >= 500, response.status);
      }
      let bytes: Uint8Array;
      try { bytes = await boundedBytes(response, (identityErrors || refreshResponse) ? 32 * 1024 : 1024 * 1024); }
      catch (e) {
        // Headers were received: a broken/oversized refusal is not transport loss
        // without an HTTP response and cannot authorize another refresh dispatch.
        if (refreshResponse && !response.ok) throw new SafeError("INVALID_REFRESH_CONFLICT", false, response.status);
        if (refreshResponse) throw new SafeError("INVALID_REFRESH_RESPONSE", false, response.status);
        throw e;
      }
      // Buffered responses keep SDK clones and parsing bounded, without exposing remote error text.
      return new Response(refreshResponse && [204, 205].includes(response.status) ? null : bytes as BodyInit, { status: response.status, headers: response.headers });
    } catch (e) {
      if (e instanceof SafeError) throw e;
      if (refreshEndpoint !== undefined && responseStatus !== undefined) throw new SafeError("INVALID_REFRESH_RESPONSE", false, responseStatus);
      throw new SafeError("TRANSPORT_FAILED", write);
    }
  };
}
export async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new SafeError("INVALID_JSON"); }
}

// Rails Organization::SLUG_FORMAT has no length cap (including uniqueness suffixes).
// The final assertion is absolute end-of-input, unlike JS $ before a final newline.
export function validOrganizationSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/.test(value);
}

export interface OrganizationChoice { slug: string; name: string }
export type AdmissionReason = "awaiting_approval" | "declined";
export type IdentityResponse = { status: 200; body: unknown } | { status: 403; error: "not_a_member"; reason?: AdmissionReason } | { status: 409; error: "organization_required" | "organization_invalid" | "organization_conflict"; organizations: OrganizationChoice[] };
// Only onboarding's exact identity GET can read these bounded, schema-checked errors.
// Runtime safeFetch still discards every error body.
export async function onboardingIdentity(origin: string, token: string, organization: string | undefined, fetchImpl: Fetch = fetch): Promise<IdentityResponse> {
  const r = await boundedFetch(origin, fetchImpl, true)(`${origin}/api/identity`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(organization ? { "Concourse-Organization": organization } : {}) } });
  const b = await json(r);
  if (r.status === 200) return { status: 200, body: b };
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new SafeError("INVALID_ONBOARDING_RESPONSE");
  const v = b as Record<string, unknown>;
  if (r.status === 403 && v.error === "not_a_member") {
    if (v.reason !== undefined && v.reason !== "awaiting_approval" && v.reason !== "declined") throw new SafeError("INVALID_ONBOARDING_RESPONSE");
    return { status: 403, error: "not_a_member", ...(v.reason ? { reason: v.reason } : {}) };
  }
  if (r.status !== 409 || !["organization_required", "organization_invalid", "organization_conflict"].includes(String(v.error)) || typeof v.message !== "string" || v.message.length > 1024 || !Array.isArray(v.organizations) || v.organizations.length > 100) throw new SafeError("INVALID_ONBOARDING_RESPONSE");
  const choices: OrganizationChoice[] = [];
  for (const c of v.organizations) {
    if (!c || typeof c !== "object" || Array.isArray(c) || !validOrganizationSlug(c.slug) || typeof c.name !== "string" || !c.name || c.name.length > 200 || /[\x00-\x1f\x7f]/.test(c.name) || choices.some(v => v.slug === c.slug)) throw new SafeError("INVALID_ONBOARDING_RESPONSE");
    choices.push({ slug: c.slug, name: c.name });
  }
  return { status: 409, error: v.error as "organization_required" | "organization_invalid" | "organization_conflict", organizations: choices };
}
