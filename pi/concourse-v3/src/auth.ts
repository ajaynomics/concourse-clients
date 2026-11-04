import { createHash, randomBytes } from "node:crypto";
import { PrivateFiles } from "./storage.ts";
import { httpsUrl, json, safeFetch, SafeError, validOrganizationSlug, type Fetch } from "./http.ts";
import { object } from "./types.ts";
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
interface Tokens { access: string; refresh?: string; expires: number; resource: string; clientId: string; issuer: string }
// Long enough for a human to read, sign in and approve, possibly from another computer.
export const AUTHORIZATION_WINDOW_MS = 15 * 60_000;
interface Pending { state: string; verifier: string; expires: number; resource: string; clientId: string; issuer: string; redirectUri: string; fresh?: true }
// Authentication is independently usable during onboarding; runtime identity remains strict.
export class TokenClient {
  private inFlight?: Promise<string>;
  private exchanging = false;
  constructor(readonly config: AuthConfig, private files: PrivateFiles, private fetchImpl: Fetch = fetch, private now = Date.now, private guard: () => void = () => {}) { validateAuthConfig(config); }
  token(): Promise<string> {
    this.guard();
    if (!this.inFlight) this.inFlight = this.acquire().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private matches(t: Tokens): boolean { return t.resource === this.config.origin && t.clientId === this.config.oauthClientId && t.issuer === this.config.issuer; }
  private async acquire(): Promise<string> {
    this.guard(); const stored = this.files.read<Tokens>("tokens.json");
    if (stored && !this.matches(stored)) throw new SafeError("TOKEN_BINDING_MISMATCH");
    if (stored && stored.expires > this.now() + 60_000 && /^[A-Za-z0-9._~+/-]+=*$/.test(stored.access)) return stored.access;
    if (this.config.auth.kind === "client_credentials") return this.grant({ grant_type: "client_credentials" });
    if (!stored?.refresh) throw new SafeError("OPERATOR_OAUTH_REQUIRED");
    if (this.files.read<boolean>("oauth-exchange.json")) throw new SafeError("OAUTH_EXCHANGE_UNCERTAIN", true);
    return this.grant({ grant_type: "refresh_token", refresh_token: stored.refresh });
  }
  authorizationUrl(options: { fresh?: boolean } = {}): string {
    this.guard();
    if (this.config.auth.kind !== "oauth" || !this.config.authorizationEndpoint) throw new SafeError("NOT_OAUTH");
    if (this.exchanging) throw new SafeError("OAUTH_EXCHANGE_IN_PROGRESS");
    if (this.files.read<boolean>("oauth-exchange.json") && !options.fresh) throw new SafeError("OAUTH_EXCHANGE_UNCERTAIN", true);
    const stored = this.files.read<Tokens>("tokens.json");
    if (stored && !this.matches(stored)) throw new SafeError("TOKEN_BINDING_MISMATCH");
    let pending = this.files.read<Pending>("oauth-pending.json");
    if (pending && (!this.validPending(pending) || pending.resource !== this.config.origin || pending.clientId !== this.config.oauthClientId || pending.issuer !== this.config.issuer || pending.redirectUri !== this.config.auth.redirectUri)) throw new SafeError("OAUTH_PENDING_BINDING_MISMATCH");
    if (options.fresh || !pending || pending.expires <= this.now()) {
      // Explicit sign-in supersedes the old PKCE intent, never the uncertain grant.
      // Keep its refresh/code replay fence until a new code succeeds (RFC 9700 §4.14).
      pending = { state: randomBytes(32).toString("base64url"), verifier: randomBytes(32).toString("base64url"), expires: this.now() + AUTHORIZATION_WINDOW_MS, resource: this.config.origin, clientId: this.config.oauthClientId, issuer: this.config.issuer, redirectUri: this.config.auth.redirectUri, ...(options.fresh ? { fresh: true as const } : {}) };
      this.files.write("oauth-pending.json", pending);
    }
    const url = new URL(this.config.authorizationEndpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: this.config.oauthClientId, redirect_uri: this.config.auth.redirectUri, scope: "concourse", resource: this.config.origin, state: pending.state, code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"), code_challenge_method: "S256" })) url.searchParams.set(k, v);
    return url.href;
  }
  private validPending(p: Pending): boolean { return typeof p.state === "string" && /^[A-Za-z0-9_-]{43}$/.test(p.state) && typeof p.verifier === "string" && /^[A-Za-z0-9_-]{43}$/.test(p.verifier) && Number.isSafeInteger(p.expires) && (p.fresh === undefined || p.fresh === true); }
  async completeAuthorization(callback: { code: string; state: string; iss?: string }, acceptToken?: (access: string) => Promise<void>): Promise<void> {
    this.guard();
    if (this.exchanging) throw new SafeError("OAUTH_EXCHANGE_IN_PROGRESS");
    const pending = this.files.read<Pending>("oauth-pending.json");
    if (this.config.auth.kind !== "oauth" || !pending || !this.validPending(pending) || pending.state !== callback.state || callback.iss !== this.config.issuer || pending.expires <= this.now() || pending.resource !== this.config.origin || pending.clientId !== this.config.oauthClientId || pending.issuer !== this.config.issuer || pending.redirectUri !== this.config.auth.redirectUri || typeof callback.code !== "string" || !callback.code || callback.code.length > 4096 || /[\x00-\x20\x7f]/.test(callback.code) || (this.files.read<boolean>("oauth-exchange.json") && !pending.fresh)) throw new SafeError("OAUTH_CALLBACK_REFUSED");
    // Consume local intent BEFORE an uncertain code exchange; never auto-retry a rotating grant.
    this.files.write("oauth-pending.json", null);
    await this.grant({ grant_type: "authorization_code", code: callback.code, code_verifier: pending.verifier, redirect_uri: this.config.auth.redirectUri }, acceptToken);
  }
  private async grant(fields: Record<string, string>, acceptToken?: (access: string) => Promise<void>): Promise<string> {
    this.guard();
    if (this.exchanging) throw new SafeError("OAUTH_EXCHANGE_IN_PROGRESS");
    this.exchanging = true;
    try {
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
      const form = new URLSearchParams({ ...fields, resource: this.config.origin, scope: "concourse" });
      if (this.config.auth.kind === "client_credentials") {
        const encode = (s: string) => new URLSearchParams({ v: s }).toString().slice(2);
        headers.authorization = `Basic ${Buffer.from(`${encode(this.config.oauthClientId)}:${encode(this.config.auth.clientSecret)}`).toString("base64")}`;
      } else form.set("client_id", this.config.oauthClientId);
      if (this.config.auth.kind === "oauth") this.files.write("oauth-exchange.json", true);
      const r = await safeFetch(new URL(this.config.tokenEndpoint).origin, this.fetchImpl)(this.config.tokenEndpoint, { method: "POST", headers, body: form.toString() });
      this.guard(); const b = await json(r); this.guard();
      if (!object(b) || typeof b.access_token !== "string" || b.access_token.length > 16_384 || !/^[A-Za-z0-9._~+/-]+=*$/.test(b.access_token) || typeof b.token_type !== "string" || b.token_type.toLowerCase() !== "bearer" || typeof b.expires_in !== "number" || !Number.isInteger(b.expires_in) || b.expires_in <= 0 || b.expires_in > 3600 || (b.scope !== undefined && b.scope !== "concourse") || (this.config.auth.kind === "client_credentials" && ("refresh_token" in b || "id_token" in b)) || (this.config.auth.kind === "oauth" && typeof b.refresh_token !== "string")) throw new SafeError("INVALID_TOKEN_RESPONSE");
      const tokens: Tokens = { access: b.access_token, expires: this.now() + b.expires_in * 1000, resource: this.config.origin, clientId: this.config.oauthClientId, issuer: this.config.issuer, ...(typeof b.refresh_token === "string" ? { refresh: b.refresh_token } : {}) };
      // Existing-profile recovery must verify identity before replacing credentials.
      await acceptToken?.(tokens.access); this.guard();
      this.files.write("tokens.json", tokens);
      if (this.config.auth.kind === "oauth") this.files.write("oauth-exchange.json", false);
      return tokens.access;
    } finally { this.exchanging = false; }
  }
}
