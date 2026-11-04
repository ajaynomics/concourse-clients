import { randomBytes } from "node:crypto";
import { AUTHORIZATION_WINDOW_MS, TokenClient, validateAuthConfig, validateConfig, type AuthConfig, type Config } from "./auth.ts";
import { PrivateFiles, createProfile } from "./storage.ts";
import { SafeError, httpsUrl, json, safeFetch, onboardingIdentity, validOrganizationSlug, type AdmissionReason, type Fetch, type OrganizationChoice } from "./http.ts";
import { Loopback } from "./loopback.ts";
import { object, type Identity } from "./types.ts";

export const EXPECTED_ISSUER = "https://app.krishnan.ca";
export const AUTOMATIC_V3_ORIGIN = "https://concourse.krishnan.ca";
// Separately negotiated issuer contract, not the legacy discovery registration_endpoint.
const nativeRegistrationEndpoint = `${EXPECTED_ISSUER}/oauth/concourse_v3/registrations`;
const slug = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const handle = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(v);
const publicClientId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,2048}$/.test(v);
interface Metadata { issuer: string; tokenEndpoint: string; authorizationEndpoint: string; registrationEndpoint: string }
interface DraftFields {
  origin: string; agent: string; metadata?: Metadata; redirectUri: string;
  identity?: Omit<Identity, "handle"> & { handle: string | null };
  card: "unattempted" | "uncertain" | "confirmed" | "refused";
}
export type Draft = DraftFields & (
  { version: 2; registration: "provisioned"; oauthClientId: string } |
  { version: 3; registration: "prepared" | "uncertain" | "refused"; oauthClientId?: never } |
  { version: 3; registration: "registered"; oauthClientId: string }
);
export type SetupEvent =
  | { phase: "authorization"; actionUrl: string; instructions: string }
  | { phase: "web_admission"; actionUrl: string; reason?: AdmissionReason; instructions: string }
  | { phase: "organization_choice"; error: string; organizations: OrganizationChoice[] }
  | { phase: "complete"; identity: { origin: string; organization: string; owner: string; agent: string }; configPath: string };
export interface SignupOptions { profile: string; origin?: string; agent?: string; oauthClientId?: string; resume?: boolean; organization?: string; noOpen?: boolean }
export interface SetupDependencies { fetchImpl?: Fetch; emit?(event: SetupEvent): void; open?(url: string): Promise<void>; signal?: AbortSignal; timeoutMs?: number }
// A browser on another computer cannot reach this host's loopback listener; the human
// pastes the failed page's address back and the agent replays it locally (RFC 8252 §7.3).
export const REMOTE_BROWSER = "If your browser is on another computer and ends on a page that will not load, copy that page's full address and give it to the agent, which runs: script/concourse-v3 callback --url '<address>'";
const AUTHORIZATION_INSTRUCTIONS = `Open this link and approve. ${REMOTE_BROWSER}`;

function exactOrigin(origin: string): void { if (typeof origin !== "string" || origin.length > 2048 || httpsUrl(origin).origin !== origin) throw new SafeError("EXPECTED_EXACT_ORIGIN"); }
function validateMetadata(v: Metadata): Metadata {
  if (!v || v.issuer !== EXPECTED_ISSUER) throw new SafeError("ISSUER_REFUSED");
  for (const endpoint of [v.authorizationEndpoint, v.tokenEndpoint, v.registrationEndpoint]) if (typeof endpoint !== "string" || endpoint.length > 2048 || httpsUrl(endpoint).origin !== EXPECTED_ISSUER) throw new SafeError("ISSUER_ENDPOINT_REFUSED");
  return v;
}
// RFC 9728 / RFC 8414 / RFC 9207: trust the explicitly expected issuer, not
// endpoints selected by a remote resource or an authorization response.
export async function discover(origin: string, fetchImpl: Fetch): Promise<Metadata> {
  exactOrigin(origin);
  const resource = await json(await safeFetch(origin, fetchImpl)(`${origin}/.well-known/oauth-protected-resource`));
  if (!object(resource) || resource.resource !== origin || !Array.isArray(resource.authorization_servers) || resource.authorization_servers.length !== 1 || resource.authorization_servers[0] !== EXPECTED_ISSUER) throw new SafeError("RESOURCE_METADATA_REFUSED");
  const issuer = await json(await safeFetch(EXPECTED_ISSUER, fetchImpl)(`${EXPECTED_ISSUER}/.well-known/oauth-authorization-server`));
  if (!object(issuer) || issuer.issuer !== EXPECTED_ISSUER || typeof issuer.authorization_endpoint !== "string" || typeof issuer.token_endpoint !== "string" || typeof issuer.registration_endpoint !== "string" || !Array.isArray(issuer.code_challenge_methods_supported) || !issuer.code_challenge_methods_supported.includes("S256") || issuer.authorization_response_iss_parameter_supported !== true || !Array.isArray(issuer.token_endpoint_auth_methods_supported) || !issuer.token_endpoint_auth_methods_supported.includes("none")) throw new SafeError("ISSUER_METADATA_REFUSED");
  return validateMetadata({ issuer: issuer.issuer, authorizationEndpoint: issuer.authorization_endpoint, tokenEndpoint: issuer.token_endpoint, registrationEndpoint: issuer.registration_endpoint });
}
function validateDraft(value: unknown): Draft {
  // Ordinary DCR clients are legacy-only. Never re-register or rebind an old draft.
  if (object(value) && value.version === 1) {
    if (value.registration === "uncertain") throw new SafeError("REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER", true);
    throw new SafeError("LEGACY_DCR_DRAFT_REQUIRES_FRESH_PROFILE");
  }
  if (!object(value) || !handle(value.agent) || !["unattempted", "uncertain", "confirmed", "refused"].includes(value.card as string)) throw new SafeError("INVALID_ONBOARDING_DRAFT");
  const registered = value.version === 2 && value.registration === "provisioned" || value.version === 3 && value.registration === "registered";
  const preparing = value.version === 3 && ["prepared", "uncertain", "refused"].includes(value.registration as string);
  if (!(registered && publicClientId(value.oauthClientId) || preparing && value.oauthClientId === undefined && value.identity === undefined && value.card === "unattempted")) throw new SafeError("INVALID_ONBOARDING_DRAFT");
  const d = value as unknown as Draft;
  exactOrigin(d.origin); if (d.metadata) validateMetadata(d.metadata);
  if (d.version === 3 && d.origin !== AUTOMATIC_V3_ORIGIN) throw new SafeError("AUTOMATIC_V3_ORIGIN_REQUIRED");
  const callback = /^http:\/\/127\.0\.0\.1:(\d+)\/callback$/.exec(d.redirectUri);
  if (!callback || Number(callback[1]) < 1024 || Number(callback[1]) > 65535) throw new SafeError("INVALID_ONBOARDING_DRAFT");
  if (d.metadata && registered) authConfig(d);
  if (d.identity) validateIdentity(d.identity, d.oauthClientId!);
  return d;
}
function registrationClientId(value: unknown, redirectUri: string): string {
  // RFC 7591 §3.2.1 public metadata plus the issuer's exact native-only contract.
  const fields = ["client_id", "client_name", "redirect_uris", "grant_types", "response_types", "token_endpoint_auth_method", "scope", "client_id_issued_at", "application_type"];
  if (!object(value) || Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field)) || !publicClientId(value.client_id) || typeof value.client_name !== "string" || !value.client_name.trim() || value.client_name.length > 255 || /[\x00-\x1f\x7f]/.test(value.client_name) || !Array.isArray(value.redirect_uris) || value.redirect_uris.length !== 1 || value.redirect_uris[0] !== redirectUri || !Array.isArray(value.grant_types) || value.grant_types.length !== 2 || !value.grant_types.includes("authorization_code") || !value.grant_types.includes("refresh_token") || !Array.isArray(value.response_types) || value.response_types.length !== 1 || value.response_types[0] !== "code" || value.token_endpoint_auth_method !== "none" || value.scope !== "concourse" || value.application_type !== "native" || !Number.isSafeInteger(value.client_id_issued_at) || Number(value.client_id_issued_at) <= 0) throw new SafeError("INVALID_V3_REGISTRATION_RESPONSE");
  return value.client_id;
}
function authConfig(d: Draft): AuthConfig {
  if (!d.metadata || !publicClientId(d.oauthClientId)) throw new SafeError("INVALID_ONBOARDING_DRAFT");
  return validateAuthConfig({ version: 3, origin: d.origin, issuer: d.metadata.issuer, tokenEndpoint: d.metadata.tokenEndpoint, authorizationEndpoint: d.metadata.authorizationEndpoint, oauthClientId: d.oauthClientId, auth: { kind: "oauth", redirectUri: d.redirectUri } });
}
function validateIdentity(v: unknown, clientId: string): Omit<Identity, "handle"> & { handle: string | null } {
  if (!object(v) || v.release_line !== 3 || !slug(v.owner) || !validOrganizationSlug(v.organization) || !(v.handle === null || handle(v.handle)) || v.oauth_client_id !== clientId || typeof v.agent_id !== "number" || !Number.isSafeInteger(v.agent_id) || v.agent_id < 1 || typeof v.network_agent !== "string" || !/^concourse\/network-[a-zA-Z0-9_-]+$/.test(v.network_agent)) throw new SafeError("V3_IDENTITY_REFUSED");
  return { release_line: 3, owner: v.owner, organization: v.organization, handle: v.handle, oauth_client_id: clientId, agent_id: v.agent_id, network_agent: v.network_agent };
}
function checkBinding(d: Draft, identity: ReturnType<typeof validateIdentity>, organization?: string): void {
  if (organization && identity.organization !== organization) throw new SafeError("ORGANIZATION_CONFLICT");
  if (identity.handle !== null && identity.handle !== d.agent) throw new SafeError("IMMUTABLE_HANDLE_CONFLICT");
  if (d.identity && ["owner", "organization", "agent_id", "oauth_client_id"].some(k => d.identity![k as keyof Identity] !== identity[k as keyof Identity])) throw new SafeError("ONBOARDING_IDENTITY_CHANGED");
}
export async function signup(options: SignupOptions, deps: SetupDependencies = {}): Promise<"complete" | "organization_choice"> {
  const fetchImpl = deps.fetchImpl ?? fetch, emit = deps.emit ?? (() => {}), listener = new Loopback();
  if (options.organization !== undefined && !validOrganizationSlug(options.organization)) throw new SafeError("INVALID_ORGANIZATION");
  if (options.resume && options.oauthClientId !== undefined) throw new SafeError("RESUME_CLIENT_OVERRIDE_REFUSED");
  if (!options.resume) {
    if (!options.origin || !handle(options.agent)) throw new SafeError("SIGNUP_ORIGIN_AND_AGENT_REQUIRED");
    if (options.oauthClientId !== undefined && !publicClientId(options.oauthClientId)) throw new SafeError("PROVISIONED_CLIENT_ID_REQUIRED");
    exactOrigin(options.origin);
    if (options.oauthClientId === undefined && options.origin !== AUTOMATIC_V3_ORIGIN) throw new SafeError("AUTOMATIC_V3_ORIGIN_REQUIRED");
    createProfile(options.profile);
  }
  const files = new PrivateFiles(options.profile);
  let release: (() => void) | undefined;
  try {
    release = files.acquire();
    const guard = () => { if (!files.ownsConsumer() || deps.signal?.aborted) throw new SafeError("SETUP_CANCELLED"); };
    if (files.read("config.json") !== undefined) throw new SafeError("PROFILE_ALREADY_CONFIGURED_USE_DOCTOR");
    let d = files.read<Draft>("onboarding.json");
    if (options.resume) {
      d = validateDraft(d!);
      if ((options.origin && options.origin !== d.origin) || (options.agent && options.agent !== d.agent)) throw new SafeError("DRAFT_OPTIONS_CONFLICT");
      if (d.registration === "uncertain") throw new SafeError("REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER", true);
      if (d.registration === "refused") throw new SafeError("V3_REGISTRATION_REFUSED");
      if (d.card === "refused") throw new SafeError("CARD_WRITE_REFUSED");
      await listener.bind(Number(new URL(d.redirectUri).port));
    } else {
      await listener.bind();
      // RFC 8252 §7.3 permits an ephemeral port; this intent then keeps its exact URI.
      const fields: DraftFields = { origin: options.origin!, agent: options.agent!, redirectUri: `http://127.0.0.1:${listener.port}/callback`, card: "unattempted" };
      d = options.oauthClientId === undefined ? { ...fields, version: 3, registration: "prepared" } : { ...fields, version: 2, registration: "provisioned", oauthClientId: options.oauthClientId };
      files.write("onboarding.json", d);
    }
    if (!d.metadata) { d.metadata = await discover(d.origin, fetchImpl); guard(); files.write("onboarding.json", d); }
    if (d.registration === "prepared") {
      guard();
      // Fence BEFORE POST: a lost/invalid success may already have created a client.
      d.registration = "uncertain"; files.write("onboarding.json", d);
      try {
        const response = await safeFetch(EXPECTED_ISSUER, fetchImpl)(nativeRegistrationEndpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_name: `Concourse v3 ${d.agent}`, redirect_uris: [d.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "concourse" }) });
        guard();
        if (response.status !== 201) throw new SafeError("INVALID_V3_REGISTRATION_RESPONSE");
        const clientId = registrationClientId(await json(response), d.redirectUri); guard();
        d = { ...d, registration: "registered", oauthClientId: clientId };
        files.write("onboarding.json", d);
      } catch (e) {
        // Stopping local work after dispatch does not prove non-registration.
        try { guard(); } catch { throw new SafeError("REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER", true); }
        if (e instanceof SafeError && e.status && e.status >= 400 && e.status < 500 && !e.uncertain) {
          d = { ...d, version: 3, registration: "refused", oauthClientId: undefined }; files.write("onboarding.json", d);
          throw new SafeError("V3_REGISTRATION_REFUSED", false, e.status);
        }
        throw new SafeError("REGISTRATION_UNCERTAIN_DO_NOT_REREGISTER", true);
      }
    }
    // Neither a registered nor a provisioned public UID proves human membership.
    const tokens = new TokenClient(authConfig(d), files, fetchImpl, Date.now, guard);
    if (!files.read("tokens.json")) {
      const actionUrl = tokens.authorizationUrl(), state = new URL(actionUrl).searchParams.get("state")!;
      const pending = files.read<{ expires: number }>("oauth-pending.json")!;
      const wait = listener.wait("/callback", state, Math.min(deps.timeoutMs ?? AUTHORIZATION_WINDOW_MS, Math.max(1, pending.expires - Date.now())), deps.signal, q => tokens.completeAuthorization({ code: q.get("code")!, state: q.get("state")!, iss: q.get("iss")! }), tokens.config.issuer);
      await action({ phase: "authorization", actionUrl, instructions: AUTHORIZATION_INSTRUCTIONS }, wait);
    }
    guard(); const token = await tokens.token(); guard();
    let result = await onboardingIdentity(d.origin, token, options.organization ?? d.identity?.organization, fetchImpl); guard();
    if (result.status === 409 && result.error === "organization_conflict") throw new SafeError("ORGANIZATION_CONFLICT");
    if (result.status === 409) {
      emit({ phase: "organization_choice", error: result.error, organizations: result.organizations });
      // A caller can select explicitly and resume; never choose the first membership.
      if (options.noOpen || options.organization) return "organization_choice";
    }
    if (result.status === 403 && result.reason === "declined") throw new SafeError("AGENT_DECLINED");
    if (result.status !== 200) {
      const reason = result.status === 403 ? result.reason : undefined;
      const instructions = reason === "awaiting_approval"
        ? `Ask an organization owner to approve this agent in Concourse organization settings. Approval alone does not finish setup. Then open or reload this URL, choose your organization, and click Continue in terminal while this command is running. ${REMOTE_BROWSER}`
        : `Open this URL and sign in to Concourse. Obtain organization membership if needed, choose your organization, and click Continue in terminal. Approval alone does not finish setup. ${REMOTE_BROWSER}`;
      const state = randomBytes(32).toString("base64url");
      const actionUrl = `${d.origin}/developer/setup?${new URLSearchParams({ port: String(listener.port), state })}`;
      const wait = listener.wait("/setup-complete", state, deps.timeoutMs ?? 600_000, deps.signal);
      const hint = await action({ phase: "web_admission", actionUrl, ...(reason ? { reason } : {}), instructions }, wait);
      // This browser account and its hint never grant terminal authority.
      result = await onboardingIdentity(d.origin, token, hint.get("organization")!, fetchImpl); guard();
      if (result.status === 200 && result.body && object(result.body) && result.body.organization !== hint.get("organization")) throw new SafeError("ORGANIZATION_CONFLICT");
    }
    if (result.status === 403) {
      if (result.reason === "declined") throw new SafeError("AGENT_DECLINED");
      if (result.reason === "awaiting_approval") throw new SafeError("AGENT_AWAITING_APPROVAL");
      throw new SafeError("WEB_ADMISSION_REQUIRED");
    }
    if (result.status !== 200) throw new SafeError("ORGANIZATION_SELECTION_REQUIRED");
    const before = validateIdentity(result.body, d.oauthClientId!); checkBinding(d, before, options.organization);
    d.identity ??= before; files.write("onboarding.json", d);
    if (d.card === "unattempted") {
      d.card = "uncertain"; files.write("onboarding.json", d);
      // An interrupted card PATCH is fenced before HTTP. Reconcile by identity,
      // never rename, re-register or blindly replay this publication.
      try {
        await safeFetch(d.origin, fetchImpl)(`${d.origin}/api/card`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", "Concourse-Organization": before.organization }, body: JSON.stringify({ handle: d.agent, name: d.agent, harness: "pi" }) });
        guard(); d.card = "confirmed"; files.write("onboarding.json", d);
      } catch (e) {
        guard();
        if (e instanceof SafeError && e.status && e.status < 500 && !e.uncertain) {
          d.card = "refused"; files.write("onboarding.json", d);
          throw new SafeError("CARD_WRITE_REFUSED", false, e.status);
        }
      }
    }
    const after = await onboardingIdentity(d.origin, token, before.organization, fetchImpl); guard();
    if (after.status !== 200) throw new SafeError("CARD_WRITE_UNCONFIRMED", true);
    const final = validateIdentity(after.body, d.oauthClientId!); checkBinding(d, final, before.organization);
    if (final.handle !== d.agent) throw new SafeError("CARD_WRITE_UNCONFIRMED", true);
    const config = validateConfig({ ...authConfig(d), organization: final.organization, owner: final.owner, agent: final.handle });
    guard();
    if (files.read("config.json") !== undefined) throw new SafeError("PROFILE_ALREADY_CONFIGURED_USE_DOCTOR");
    files.write("config.json", config);
    emit({ phase: "complete", identity: { origin: d.origin, organization: config.organization, owner: config.owner, agent: config.agent }, configPath: `${options.profile}/config.json` });
    return "complete";
    async function action(event: Extract<SetupEvent, { actionUrl: string }>, wait: Promise<URLSearchParams>): Promise<URLSearchParams> {
      // Attach immediately so cancellation while opening cannot reject unhandled.
      void wait.catch(() => {}); emit(event);
      if (!options.noOpen) await deps.open?.(event.actionUrl);
      return wait;
    }
  } finally { await listener.close(); release?.(); files.close(); }
}
// Explicit same-client recovery, never a retry of the uncertain rotating grant.
export async function login(options: { profile: string; noOpen?: boolean }, deps: SetupDependencies = {}): Promise<"complete"> {
  const files = new PrivateFiles(options.profile), listener = new Loopback();
  let release: (() => void) | undefined;
  try {
    release = files.acquire();
    const guard = () => { if (!files.ownsConsumer() || deps.signal?.aborted) throw new SafeError("SETUP_CANCELLED"); };
    guard();
    const config = validateConfig(files.read<Config>("config.json")!);
    if (config.auth.kind !== "oauth") throw new SafeError("NOT_OAUTH");
    const fetchImpl = deps.fetchImpl ?? fetch;
    const tokens = new TokenClient(config, files, fetchImpl, Date.now, guard);
    await listener.bind(Number(new URL(config.auth.redirectUri).port)); guard();
    const actionUrl = tokens.authorizationUrl({ fresh: true });
    const state = new URL(actionUrl).searchParams.get("state")!;
    const pending = files.read<{ expires: number }>("oauth-pending.json")!;
    const wait = listener.wait("/callback", state, Math.min(deps.timeoutMs ?? AUTHORIZATION_WINDOW_MS, Math.max(1, pending.expires - Date.now())), deps.signal, async q => {
      guard();
      await tokens.completeAuthorization({ code: q.get("code")!, state: q.get("state")!, iss: q.get("iss")! }, async access => {
        guard();
        const result = await onboardingIdentity(config.origin, access, config.organization, fetchImpl); guard();
        if (result.status !== 200) throw new SafeError("V3_IDENTITY_REFUSED");
        const id = validateIdentity(result.body, config.oauthClientId);
        if (id.owner !== config.owner || id.organization !== config.organization || id.handle !== config.agent) throw new SafeError("V3_IDENTITY_REFUSED");
      });
      guard();
    }, config.issuer);
    void wait.catch(() => {});
    deps.emit?.({ phase: "authorization", actionUrl, instructions: AUTHORIZATION_INSTRUCTIONS }); guard();
    if (!options.noOpen) { await deps.open?.(actionUrl); guard(); }
    await wait; guard();
    deps.emit?.({ phase: "complete", identity: { origin: config.origin, organization: config.organization, owner: config.owner, agent: config.agent }, configPath: `${options.profile}/config.json` });
    return "complete";
  } finally { await listener.close(); release?.(); files.close(); }
}
export async function doctor(profile: string, fetchImpl: Fetch = fetch): Promise<{ phase: "healthy"; identity: { origin: string; organization: string; owner: string; agent: string } }> {
  const files = new PrivateFiles(profile); let release: (() => void) | undefined;
  try {
    release = files.acquire(); const config = validateConfig(files.read<Config>("config.json")!);
    const tokens = new TokenClient(config, files, fetchImpl);
    const result = await onboardingIdentity(config.origin, await tokens.token(), config.organization, fetchImpl);
    if (result.status !== 200) throw new SafeError("V3_IDENTITY_REFUSED");
    const id = validateIdentity(result.body, config.oauthClientId);
    if (id.owner !== config.owner || id.organization !== config.organization || id.handle !== config.agent) throw new SafeError("V3_IDENTITY_REFUSED");
    return { phase: "healthy", identity: { origin: config.origin, organization: id.organization, owner: id.owner, agent: id.handle } };
  } finally { release?.(); files.close(); }
}
