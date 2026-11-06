import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as wait } from "node:timers/promises";
import { PrivateFiles } from "./storage.ts";
import { httpsUrl, json, refreshFetch, safeFetch, SafeError, validOrganizationSlug, type Fetch } from "./http.ts";
import { object } from "./types.ts";
import { Client } from "./client.ts";
import { committed, commitReceipt, fingerprint, markRequest, newExchange, parseExchange, refreshBinding, reserveDispatch, responseReceipt, resumable, sameExchange, supportsRecovery, validatedConflict, validBearer, validRefresh, type RecoveryCapability, type RefreshCommit, type RefreshExchange, type VerifiedIdentity } from "./refresh.ts";
export interface AuthConfig {
  version: 3; origin: string; oauthClientId: string;
  issuer: string; tokenEndpoint: string; authorizationEndpoint?: string;
  auth: { kind: "client_credentials"; clientSecret: string } | { kind: "oauth"; redirectUri: string };
}
export interface Config extends AuthConfig { organization: string; owner: string; agent: string }
export function validateAuthConfig(c: AuthConfig): AuthConfig {
  if (!c || c.version !== 3) throw new SafeError("INVALID_V3_CONFIG");
  const origin = httpsUrl(c.origin), issuer = httpsUrl(c.issuer);
  if (origin.origin !== c.origin) throw new SafeError("EXPECTED_EXACT_ORIGIN");
  if (httpsUrl(c.tokenEndpoint).origin !== issuer.origin) throw new SafeError("TOKEN_ORIGIN_REFUSED");
  if (typeof c.oauthClientId !== "string" || !c.oauthClientId || c.oauthClientId.length > 2048 || /[\x00-\x20\x7f]/.test(c.oauthClientId)) throw new SafeError("INVALID_CLIENT_ID");
  if (c.auth?.kind === "oauth") {
    const match = /^http:\/\/127\.0\.0\.1:(\d+)\/callback$/.exec(c.auth.redirectUri);
    if (!c.authorizationEndpoint || httpsUrl(c.authorizationEndpoint).origin !== issuer.origin || !match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw new SafeError("INVALID_OAUTH_CONFIG");
  } else if (c.auth?.kind !== "client_credentials" || !c.auth.clientSecret) throw new SafeError("INVALID_AUTH_CONFIG");
  return structuredClone(c);
}
export function validateConfig(c: Config): Config {
  validateAuthConfig(c);
  if (!validOrganizationSlug(c.organization)) throw new SafeError("INVALID_EXPECTED_IDENTITY");
  for (const s of [c.owner, c.agent]) if (typeof s !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(s)) throw new SafeError("INVALID_EXPECTED_IDENTITY");
  return structuredClone(c);
}
interface CodeCommit { version: 1; id: string; ownerEpoch: string; bindingFingerprint: string; fenceFingerprint: string; accessFingerprint: string; successorFingerprint: string; expires: number; identity?: VerifiedIdentity }
interface CodeExchange { version: 1; id: string; ownerEpoch: string; bindingFingerprint: string; fenceFingerprint: string; phase: "dispatch-uncertain" | "committing"; commit?: CodeCommit }
interface Tokens { access: string; refresh?: string; expires: number; resource: string; clientId: string; issuer: string; refreshCommit?: RefreshCommit; codeCommit?: CodeCommit }
const unresolved = (fence: unknown): boolean => fence !== undefined && fence !== false;
const snapshot = (value: unknown): string => fingerprint(JSON.stringify(value ?? null));
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/.test(value);
const signInRequired = (status?: number) => new SafeError("OPERATOR_OAUTH_REQUIRED", false, status, {}, "The issuer refused this refresh token. Sign in again with script/concourse-v3 login");
// Long enough for a human to read, sign in and approve, possibly from another computer.
export const AUTHORIZATION_WINDOW_MS = 15 * 60_000;
interface Pending { state: string; verifier: string; expires: number; resource: string; clientId: string; issuer: string; redirectUri: string; fresh?: true }
// Authentication is independently usable during onboarding; runtime identity remains strict.
export class TokenClient {
  private inFlight?: Promise<string>;
  private exchanging = false;
  private poisoned = false;
  private readonly ownerEpoch?: string;
  constructor(readonly config: AuthConfig, private files: PrivateFiles, private fetchImpl: Fetch = fetch, private now = Date.now, private lifetime: () => void = () => {}, private pause: (milliseconds: number) => Promise<unknown> = wait) {
    validateAuthConfig(config);
    if (config.auth.kind === "oauth" && files.ownsConsumer()) this.ownerEpoch = files.consumerEpoch();
  }
  private guard(): void {
    this.lifetime();
    if (this.ownerEpoch !== undefined && !this.files.ownsConsumer(this.ownerEpoch)) throw new SafeError("OAUTH_RESPONSE_SUPERSEDED");
    if (this.poisoned) throw new SafeError("OAUTH_STORAGE_UNCERTAIN", true);
  }
  private write(name: string, value: unknown): void {
    this.guard();
    try { this.files.write(name, value); } catch (e) { this.poisoned = true; throw e; }
    this.guard();
  }
  private expectedConfig(): Config | undefined {
    if (!("organization" in this.config) || !("owner" in this.config) || !("agent" in this.config)) return;
    return validateConfig(this.config as Config);
  }
  token(): Promise<string> {
    this.guard();
    if (!this.inFlight) this.inFlight = this.acquire().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private matches(t: Tokens): boolean { return t.resource === this.config.origin && t.clientId === this.config.oauthClientId && t.issuer === this.config.issuer; }
  private async acquire(): Promise<string> {
    this.guard(); const stored = this.files.read<Tokens>("tokens.json");
    if (stored && !this.matches(stored)) throw new SafeError("TOKEN_BINDING_MISMATCH");
    const cached = stored && stored.expires > this.now() + 60_000 && validBearer(stored.access);
    if (this.config.auth.kind === "client_credentials") return cached ? stored.access : this.grant({ grant_type: "client_credentials" });
    const codeFence = this.files.read<unknown>("oauth-code-exchange.json");
    const codeSettled = stored && this.codeCommitted(codeFence, stored);
    if (codeSettled) {
      this.files.consumerEpoch();
      this.write("oauth-exchange.json", false);
      this.write("oauth-code-exchange.json", false);
    }
    if (!stored?.refresh) { if (cached) return stored.access; throw new SafeError("OPERATOR_OAUTH_REQUIRED"); }
    const fence = this.files.read<unknown>("oauth-exchange.json"), expected = this.expectedConfig();
    let exchange = expected ? parseExchange(fence, refreshBinding(expected)) : undefined;
    // Only an exact commit-ready journal and atomic credentials/identity receipt
    // can settle an interrupted clear, even after that access token expires.
    const settled = exchange && committed(exchange, stored.refreshCommit, stored);
    if (settled) { this.files.consumerEpoch(); this.write("oauth-exchange.json", false); exchange = undefined; }
    if (cached) return stored.access;
    if (unresolved(codeFence) && !codeSettled) throw new SafeError("OAUTH_EXCHANGE_UNCERTAIN", true);
    if (!settled && unresolved(fence)) {
      if (exchange?.phase === "refused") throw signInRequired();
      if (!exchange || !resumable(exchange) || exchange.parentFingerprint !== fingerprint(stored.refresh)) throw new SafeError("OAUTH_EXCHANGE_UNCERTAIN", true);
    }
    return this.grant({ grant_type: "refresh_token", refresh_token: stored.refresh }, undefined, exchange);
  }
  // Read-only view for health and warnings; it uses the same predicates as acquire().
  exchangeState(): "clear" | "resumable" | "refused" | "fenced" {
    const stored = this.files.read<Tokens>("tokens.json");
    const codeFence = this.files.read<unknown>("oauth-code-exchange.json");
    if (unresolved(codeFence)) return stored && this.codeCommitted(codeFence, stored) ? "clear" : "fenced";
    const fence = this.files.read<unknown>("oauth-exchange.json");
    if (!unresolved(fence)) return "clear";
    const expected = this.expectedConfig();
    const exchange = expected ? parseExchange(fence, refreshBinding(expected)) : undefined;
    if (exchange && stored && committed(exchange, stored.refreshCommit, stored)) return "clear";
    if (exchange?.phase === "refused") return "refused";
    return exchange && stored?.refresh && resumable(exchange) && exchange.parentFingerprint === fingerprint(stored.refresh) ? "resumable" : "fenced";
  }
  authorizationUrl(options: { fresh?: boolean } = {}): string {
    this.guard(); this.files.consumerEpoch();
    if (this.config.auth.kind !== "oauth" || !this.config.authorizationEndpoint) throw new SafeError("NOT_OAUTH");
    if (this.exchanging) throw new SafeError("OAUTH_EXCHANGE_IN_PROGRESS");
    if ((unresolved(this.files.read<unknown>("oauth-exchange.json")) || unresolved(this.files.read<unknown>("oauth-code-exchange.json"))) && !options.fresh) throw new SafeError("OAUTH_EXCHANGE_UNCERTAIN", true);
    const stored = this.files.read<Tokens>("tokens.json");
    if (stored && !this.matches(stored)) throw new SafeError("TOKEN_BINDING_MISMATCH");
    let pending = this.files.read<Pending>("oauth-pending.json");
    if (pending && (!this.validPending(pending) || pending.resource !== this.config.origin || pending.clientId !== this.config.oauthClientId || pending.issuer !== this.config.issuer || pending.redirectUri !== this.config.auth.redirectUri)) throw new SafeError("OAUTH_PENDING_BINDING_MISMATCH");
    if (options.fresh || !pending || pending.expires <= this.now()) {
      // Explicit sign-in supersedes the old PKCE intent, never the uncertain grant.
      // Keep its refresh/code replay fence until a new code succeeds (RFC 9700 §4.14).
      pending = { state: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url"), expires: this.now() + AUTHORIZATION_WINDOW_MS, resource: this.config.origin, clientId: this.config.oauthClientId, issuer: this.config.issuer, redirectUri: this.config.auth.redirectUri, ...(options.fresh ? { fresh: true as const } : {}) };
      this.write("oauth-pending.json", pending);
    }
    const url = new URL(this.config.authorizationEndpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: this.config.oauthClientId, redirect_uri: this.config.auth.redirectUri, scope: "concourse", resource: this.config.origin, state: pending.state, code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"), code_challenge_method: "S256" })) url.searchParams.set(k, v);
    return url.href;
  }
  private validPending(p: Pending): boolean { return typeof p.state === "string" && /^[A-Za-z0-9_-]{43}$/.test(p.state) && typeof p.verifier === "string" && /^[A-Za-z0-9_-]{43}$/.test(p.verifier) && Number.isSafeInteger(p.expires) && (p.fresh === undefined || p.fresh === true); }
  async completeAuthorization(callback: { code: string; state: string; iss?: string }, acceptToken?: (access: string) => Promise<void>): Promise<void> {
    this.guard(); this.files.consumerEpoch();
    if (this.exchanging) throw new SafeError("OAUTH_EXCHANGE_IN_PROGRESS");
    const pending = this.files.read<Pending>("oauth-pending.json");
    if (this.config.auth.kind !== "oauth" || !pending || !this.validPending(pending) || pending.state !== callback.state || callback.iss !== this.config.issuer || pending.expires <= this.now() || pending.resource !== this.config.origin || pending.clientId !== this.config.oauthClientId || pending.issuer !== this.config.issuer || pending.redirectUri !== this.config.auth.redirectUri || typeof callback.code !== "string" || !callback.code || callback.code.length > 4096 || /[\x00-\x20\x7f]/.test(callback.code) || ((unresolved(this.files.read<unknown>("oauth-exchange.json")) || unresolved(this.files.read<unknown>("oauth-code-exchange.json"))) && !pending.fresh)) throw new SafeError("OAUTH_CALLBACK_REFUSED");
    // Consume local intent BEFORE an uncertain code exchange; never auto-retry a rotating grant.
    this.write("oauth-pending.json", null);
    this.guard(); await this.grant({ grant_type: "authorization_code", code: callback.code, code_verifier: pending.verifier, redirect_uri: this.config.auth.redirectUri }, acceptToken); this.guard();
  }
  private codeCommitted(value: unknown, tokens: Tokens): boolean {
    if (!object(value) || value.version !== 1 || !uuid(value.id) || !uuid(value.ownerEpoch) || value.phase !== "committing" || !object(value.commit) || Object.keys(value).sort().join(",") !== "bindingFingerprint,commit,fenceFingerprint,id,ownerEpoch,phase,version") return false;
    const c = value.commit, expected = this.expectedConfig();
    if (value.bindingFingerprint !== snapshot(this.config) || (value.fenceFingerprint !== snapshot(this.files.read("oauth-exchange.json")) && this.files.read("oauth-exchange.json") !== false)) return false;
    if (!validBearer(tokens.access) || !validRefresh(tokens.refresh) || !Number.isSafeInteger(tokens.expires) || tokens.expires <= 0 || !isDeepStrictEqual(c, tokens.codeCommit)) return false;
    if (c.version !== 1 || c.id !== value.id || c.ownerEpoch !== value.ownerEpoch || c.bindingFingerprint !== value.bindingFingerprint || c.fenceFingerprint !== value.fenceFingerprint || c.accessFingerprint !== fingerprint(tokens.access) || c.successorFingerprint !== fingerprint(tokens.refresh) || c.expires !== tokens.expires) return false;
    const keys = "accessFingerprint,bindingFingerprint,expires,fenceFingerprint,id,ownerEpoch,successorFingerprint,version";
    if (Object.keys(c).filter(k => k !== "identity").sort().join(",") !== keys) return false;
    if (expected) {
      const id = c.identity;
      return object(id) && Object.keys(id).sort().join(",") === "agent_id,handle,oauth_client_id,organization,owner,release_line" && id.release_line === 3 && id.organization === expected.organization && id.owner === expected.owner && id.handle === expected.agent && id.oauth_client_id === expected.oauthClientId && Number.isSafeInteger(id.agent_id) && Number(id.agent_id) > 0;
    }
    return c.identity === undefined;
  }
  private async grant(fields: Record<string, string>, acceptToken?: (access: string) => Promise<void>, exchange?: RefreshExchange): Promise<string> {
    this.guard();
    if (this.exchanging) throw new SafeError("OAUTH_EXCHANGE_IN_PROGRESS");
    const oauth = this.config.auth.kind === "oauth", epoch = oauth ? this.files.consumerEpoch() : undefined;
    let fence = this.files.read<unknown>("oauth-exchange.json");
    let codeFence = this.files.read<unknown>("oauth-code-exchange.json");
    let tokenSnapshot = this.files.read<unknown>("tokens.json");
    const pendingSnapshot = this.files.read<unknown>("oauth-pending.json"), configSnapshot = this.files.read<unknown>("config.json");
    // Check errors too: a late refusal must not fence a newer healthy exchange.
    const current = () => {
      this.guard();
      if (!oauth) return;
      if (this.files.consumerEpoch() !== epoch) throw new SafeError("OAUTH_RESPONSE_SUPERSEDED");
      const live = this.files.read<unknown>("oauth-exchange.json");
      const same = exchange ? sameExchange(parseExchange(live, exchange.binding), exchange) : isDeepStrictEqual(live, fence);
      if (!same || !isDeepStrictEqual(this.files.read("oauth-code-exchange.json"), codeFence) || !isDeepStrictEqual(this.files.read("tokens.json"), tokenSnapshot) || !isDeepStrictEqual(this.files.read("oauth-pending.json"), pendingSnapshot) || !isDeepStrictEqual(this.files.read("config.json"), configSnapshot)) throw new SafeError("OAUTH_RESPONSE_SUPERSEDED");
    };
    const saveExchange = (next: RefreshExchange | boolean) => { current(); this.write("oauth-exchange.json", next); fence = next; exchange = typeof next === "object" ? next : undefined; };
    const saveCode = (next: CodeExchange | false) => { current(); this.write("oauth-code-exchange.json", next); codeFence = next; };
    this.exchanging = true;
    try {
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
      const form = new URLSearchParams({ ...fields, resource: this.config.origin, scope: "concourse" });
      if (this.config.auth.kind === "client_credentials") {
        const encode = (s: string) => new URLSearchParams({ v: s }).toString().slice(2);
        headers.authorization = `Basic ${Buffer.from(`${encode(this.config.oauthClientId)}:${encode(this.config.auth.clientSecret)}`).toString("base64")}`;
      } else form.set("client_id", this.config.oauthClientId);
      const expected = oauth ? this.expectedConfig() : undefined;
      let capability: RecoveryCapability | undefined;
      if (expected && fields.grant_type === "refresh_token") {
        current(); capability = await supportsRecovery(expected, this.fetchImpl, current); current();
        if (exchange && !capability) throw new SafeError("OAUTH_EXCHANGE_UNCERTAIN", true);
        if (capability) {
          // A saved conflict always waits a full second, including after restart.
          // The issuer alone decides whether its 24-hour window still permits it.
          if (exchange?.phase === "conflict") { await this.pause(1000); current(); }
          const reserved = exchange ? reserveDispatch(exchange, epoch!) : newExchange(refreshBinding(expected), fields.refresh_token, epoch!);
          saveExchange(reserved); markRequest(capability, reserved, form, headers);
        }
      }
      let code: CodeExchange | undefined;
      if (oauth && fields.grant_type === "authorization_code") {
        code = { version: 1, id: randomUUID(), ownerEpoch: epoch!, bindingFingerprint: snapshot(this.config), fenceFingerprint: snapshot(fence), phase: "dispatch-uncertain" };
        // Retain the original refresh fence until this separate code succeeds.
        saveCode(code);
      } else if (oauth && !exchange) saveExchange(true);
      let r: Response;
      current();
      try {
        const transport = exchange ? refreshFetch(this.config.tokenEndpoint, this.fetchImpl) : safeFetch(new URL(this.config.tokenEndpoint).origin, this.fetchImpl);
        r = await transport(this.config.tokenEndpoint, { method: "POST", headers, body: form.toString() });
      } catch (e) {
        current();
        if (exchange) {
          const status = e instanceof SafeError ? e.status : undefined;
          if (e instanceof SafeError && e.code === "TRANSPORT_FAILED" && status === undefined) {
            if (resumable(exchange)) {
              saveExchange({ ...exchange, phase: "retry-eligible" });
              throw new SafeError("TRANSPORT_FAILED", false, undefined, {}, "The token refresh resumes with the same exchange on the next request");
            }
            saveExchange({ ...exchange, phase: "locked" }); throw new SafeError("OAUTH_EXCHANGE_UNCERTAIN", true);
          }
          if (status !== undefined && [400, 401, 403].includes(status)) { saveExchange({ ...exchange, phase: "refused" }); throw signInRequired(status); }
          saveExchange({ ...exchange, phase: "locked" });
        }
        throw e;
      }
      current();
      if (exchange && r.status === 409) {
        try { await validatedConflict(r, exchange); }
        catch (e) { current(); saveExchange({ ...exchange, phase: "locked" }); throw e; }
        current();
        const conflict: RefreshExchange = { ...exchange, phase: "conflict" };
        if (!resumable(conflict)) { saveExchange({ ...exchange, phase: "locked" }); throw new SafeError("OAUTH_EXCHANGE_UNCERTAIN", true); }
        saveExchange(conflict);
        throw new SafeError("REFRESH_IN_PROGRESS", false, 409, {}, "The next request waits before another dispatch of this same exchange");
      }
      if (exchange) saveExchange({ ...exchange, phase: "processing" });
      let b: unknown;
      try { b = await json(r); } catch (e) { current(); throw e; }
      current();
      if (!object(b) || !validBearer(b.access_token) || typeof b.token_type !== "string" || b.token_type.toLowerCase() !== "bearer" || typeof b.expires_in !== "number" || !Number.isInteger(b.expires_in) || b.expires_in <= 0 || b.expires_in > 3600 || (b.scope !== undefined && b.scope !== "concourse") || (this.config.auth.kind === "client_credentials" && ("refresh_token" in b || "id_token" in b)) || (oauth && !validRefresh(b.refresh_token))) throw new SafeError("INVALID_TOKEN_RESPONSE");
      const receipt = exchange ? responseReceipt(b, exchange) : undefined;
      const tokens: Tokens = { access: b.access_token, expires: this.now() + b.expires_in * 1000, resource: this.config.origin, clientId: this.config.oauthClientId, issuer: this.config.issuer, ...(typeof b.refresh_token === "string" ? { refresh: b.refresh_token } : {}) };
      let verified: VerifiedIdentity | undefined;
      if (expected && (exchange || code)) {
        const candidate = new Client(expected, async () => { current(); return tokens.access; }, this.fetchImpl, () => { current(); return true; });
        try {
          const id = await candidate.identity(); current();
          if (!Number.isSafeInteger(id.agent_id) || id.agent_id <= 0) throw new SafeError("V3_IDENTITY_REFUSED");
          verified = { release_line: id.release_line, organization: id.organization, owner: id.owner, handle: id.handle, oauth_client_id: id.oauth_client_id, agent_id: id.agent_id };
        } catch (e) { current(); throw e; }
      }
      try { current(); await acceptToken?.(tokens.access); } catch (e) { current(); throw e; }
      current();
      if (exchange && receipt && verified) {
        tokens.refreshCommit = commitReceipt(exchange, receipt, verified, tokens.access, tokens.refresh!, tokens.expires);
        saveExchange({ ...exchange, phase: "committing", commit: tokens.refreshCommit });
      }
      if (code) {
        tokens.codeCommit = { version: 1, id: code.id, ownerEpoch: code.ownerEpoch, bindingFingerprint: code.bindingFingerprint, fenceFingerprint: code.fenceFingerprint, accessFingerprint: fingerprint(tokens.access), successorFingerprint: fingerprint(tokens.refresh!), expires: tokens.expires, ...(verified ? { identity: verified } : {}) };
        code = { ...code, phase: "committing", commit: tokens.codeCommit }; saveCode(code);
      }
      current(); this.write("tokens.json", tokens); tokenSnapshot = tokens;
      if (oauth) saveExchange(false);
      if (code) saveCode(false);
      return tokens.access;
    } finally { this.exchanging = false; }
  }
}