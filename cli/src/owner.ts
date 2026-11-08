import { boundedBytes, safeFetch, SafeError, type Fetch } from "../../pi/concourse-v3/src/http.ts";
import { withProfile } from "../../pi/concourse-v3/src/commands.ts";
import { object } from "../../pi/concourse-v3/src/types.ts";
import { UsageError } from "./args.ts";

// An unnamed agent has a null address until it is named.
// Concourse owner actions (server Agent::OwnerAuthority, /auth.md "Owner actions"):
// an organization owner's own signed-in agent approves, declines and retires agents.
export type OwnerAction = "pending" | "approve" | "decline" | "retire";
const ID = /^[1-9][0-9]{0,18}$/;
const STATUSES = ["admitted", "awaiting_approval", "declined"];
export function ownerRoute(action: OwnerAction, id?: string): { method: string; path: string } {
  if (action === "pending") return { method: "GET", path: "api/pending_agents" };
  if (id === undefined || !ID.test(id)) throw new UsageError("The agent id is a number, such as 42. Find it with concourse pending or concourse agents.");
  if (action === "approve") return { method: "POST", path: `api/agents/${id}/approval` };
  if (action === "decline") return { method: "DELETE", path: `api/pending_agents/${id}` };
  return { method: "POST", path: `api/agents/${id}/retirement` };
}
// The documented refusals, each with its status. Anything else keeps the plain HTTP code.
const REFUSALS: Record<string, { status: number; code: string; text: string; next?: string }> = {
  machine_client: { status: 403, code: "MACHINE_CLIENT", text: "Only an agent its person signed in can act for them. An app's unattended credential cannot.", next: "Use a profile its owner signed in for with concourse join or concourse login." },
  owner_required: { status: 403, code: "OWNER_REQUIRED", text: "Only an owner of this organization can do this, through their own agent.", next: "Ask an organization owner, or act on the web if you are one." },
  not_found: { status: 404, code: "AGENT_NOT_FOUND", text: "No such agent in your organization.", next: "Find ids with concourse pending or concourse agents." },
  not_pending: { status: 422, code: "NOT_PENDING", text: "This agent is admitted. Retire it instead." },
  self_retirement: { status: 422, code: "SELF_RETIREMENT", text: "An agent cannot retire itself." },
};
const UNCERTAIN = "The server may have applied it. Check with concourse pending or concourse agents. Repeating an action that already took effect changes nothing.";

export async function ownerAction(profile: string, action: OwnerAction, id: string | undefined, fetchImpl: Fetch = fetch): Promise<unknown> {
  const { method, path } = ownerRoute(action, id), write = method !== "GET";
  return withProfile(profile, fetchImpl, async ({ config, client, tokens, guard }) => {
    // Act only as the identity this profile was configured for.
    await client.identity(); guard();
    const token = await tokens.token(); guard();
    // safeFetch discards refusal bodies. Read a small one first to learn its documented code;
    // safeFetch still decides status, redirects, size and uncertainty from the same response.
    let refusal: Uint8Array | undefined;
    const keep: Fetch = async (input, init) => {
      const r = await fetchImpl(input, init);
      if (r.status < 400) return r;
      refusal = await boundedBytes(r, 16 * 1024).catch(() => new Uint8Array());
      return new Response(refusal as BodyInit, { status: r.status, statusText: r.statusText, headers: r.headers });
    };
    let response: Response;
    try { response = await safeFetch(config.origin, keep)(`${config.origin}/${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json" } }); }
    catch (e) {
      if (e instanceof SafeError && e.status && e.status >= 400 && refusal) throw refused(e, refusal);
      if (e instanceof SafeError && e.uncertain) throw new SafeError(e.code, true, e.status, e.details, UNCERTAIN);
      throw e;
    }
    guard();
    let body: unknown;
    try { body = await response.json(); } catch { /* checked below */ }
    if (action === "pending") {
      if (!object(body) || !Array.isArray(body.agents) || !body.agents.every(a => object(a) && Number.isSafeInteger(a.id) && (typeof a.address === "string" || a.address === null))) throw new SafeError("INVALID_OWNER_RESPONSE");
    } else if (!object(body) || !Number.isSafeInteger(body.id) || !(typeof body.address === "string" || body.address === null) || !STATUSES.includes(body.status as string)) {
      // The server answered 200, so the action most likely happened; only its answer is unreadable.
      throw new SafeError("INVALID_OWNER_RESPONSE", true, response.status, {}, UNCERTAIN);
    }
    return body;
  });
}
function refused(e: SafeError, bytes: Uint8Array): SafeError {
  let reason: string | undefined, message: string | undefined;
  try {
    const b = JSON.parse(new TextDecoder().decode(bytes));
    if (object(b) && typeof b.error === "string" && /^[a-z_]{1,64}$/.test(b.error)) reason = b.error;
    if (object(b) && typeof b.message === "string" && b.message.trim() && b.message.length <= 500) message = b.message;
  } catch { /* an unreadable refusal keeps its HTTP code */ }
  const known = reason && Object.hasOwn(REFUSALS, reason) ? REFUSALS[reason] : undefined;
  if (known && known.status === e.status) return new SafeError(known.code, false, e.status, { status: e.status, reason: reason! }, [message ?? known.text, known.next].filter(Boolean).join(" "));
  return new SafeError(e.code, e.uncertain, e.status, { status: e.status!, ...(reason ? { reason } : {}) }, e.uncertain ? UNCERTAIN : undefined);
}
