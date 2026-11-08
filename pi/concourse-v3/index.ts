import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fullTaskId, RECIPIENT_PATTERN } from "./src/client.ts";
import { DELIVERY_TYPE } from "./src/delivery.ts";
import { SafeError, type Fetch } from "./src/http.ts";
import type { ObjectValue } from "./src/types.ts";
import type { PrivateFiles } from "./src/storage.ts";
import { toolResult } from "./src/results.ts";
import { PEER_GUIDELINE } from "./src/format.ts";
import { DISPLAY_FILE, mailRenderer, type Display } from "./src/render.ts";
import { Handoffs } from "./src/handoff.ts";
import { ANSWER_TYPE, explain, openProfile, Runtime, type Host } from "./src/runtime.ts";

export function install(pi: ExtensionAPI, fetchImpl: Fetch = fetch): void {
  pi.registerFlag("concourse-v3-profile", { type: "string", description: "Explicit authorized absolute concourse-v3/profile/config.json, or several separated by commas; no legacy profile discovery" });
  let runtimes: Runtime[] = [], generation = 0, closing: Promise<void> = Promise.resolve();
  const tools: ToolDefinition[] = [];
  let display: Display = { collapse: false };
  const renderer = mailRenderer(() => display);
  pi.registerMessageRenderer(DELIVERY_TYPE, renderer); pi.registerMessageRenderer(ANSWER_TYPE, renderer);
  // Mail and answers queued in Pi stay tracked until consumed, so Escape cannot silently drop them.
  const handoffs = new Handoffs(pi, [DELIVERY_TYPE, ANSWER_TYPE]);
  const names = () => runtimes.map(r => r.id).join(", ");
  // Profiles share only the Pi session; each keeps its own lock, ledger and connection.
  function attach(fresh: ExtensionContext): void {
    if (!runtimes.length) throw new SafeError("V3_NOT_CONNECTED");
    for (const r of runtimes) { r.life.check(); if (fresh.sessionManager.getSessionId() !== r.sessionId) throw new SafeError("SESSION_REPLACED"); r.ctx = fresh; }
  }
  function named(profile: string): Runtime {
    const r = runtimes.find(r => r.matches(profile)); if (!r) throw new SafeError(`PROFILE_UNKNOWN: use one of ${names()}`); return r;
  }
  function one(profile?: string): Runtime {
    if (profile !== undefined) return named(profile);
    if (runtimes.length > 1) throw new SafeError(`PROFILE_REQUIRED: use one of ${names()}`);
    return runtimes[0];
  }
  // A reply goes back through the profile whose ledger received the Task, never another server.
  function replier(taskId: string, profile?: string): Runtime {
    const known = runtimes.filter(r => r.received(taskId));
    if (!known.length) return one(profile);
    const r = profile === undefined ? (known.length === 1 ? known[0] : undefined) : known.find(k => k.matches(profile));
    if (!r) throw new SafeError(`REPLY_PROFILE_MISMATCH: Task ${taskId} arrived through ${known.map(k => k.id).join(", ")}`);
    return r;
  }
  function shutdown(): Promise<void> {
    generation++; handoffs.reset(); const old = runtimes; runtimes = []; if (!old.length) return closing;
    closing = Promise.all(old.map(r => r.stop())).then(() => {}); return closing;
  }
  pi.on("session_start", async (_event, fresh) => {
    // Inactive tools need codemode reachability after transcript loadout restoration.
    // Active direct tools must keep Pi's native codemode-only declaration hiding.
    const active = new Set(pi.getActiveTools());
    if (active.has("codemode")) for (const definition of tools) if (!active.has(definition.name)) pi.registerTool({ ...definition, exposure: "codemode" });
    const old = shutdown(), ticket = generation; await old; if (ticket !== generation) return;
    const flag = pi.getFlag("concourse-v3-profile"); if (typeof flag !== "string" || !flag) return;
    const host: Host = { fetchImpl, current: r => runtimes.includes(r) && generation === ticket, labelled: () => runtimes.length > 1, handOff: m => handoffs.send(m) };
    const loaded: Runtime[] = [];
    // Open every profile before any starts, so the first mail already knows whether to carry a label.
    for (const path of flag.split(",").map(p => p.trim())) {
      let files: PrivateFiles | undefined;
      try {
        const opened = openProfile(path); files = opened.files; const c = opened.config;
        if (loaded.some(r => r.config.origin === c.origin && r.config.owner === c.owner && r.config.agent === c.agent)) throw new SafeError("DUPLICATE_PROFILE_IDENTITY");
        // Collapse is one setting: the first profile's display.json decides, and the command writes all.
        if (!loaded.length) display = { collapse: files.read<Partial<Display>>(DISPLAY_FILE)?.collapse === true };
        loaded.push(new Runtime(host, fresh, files, c, loaded.length ? `concourse-v3:${loaded.length + 1}` : "concourse-v3"));
      } catch (e) { files?.close(); fresh.ui.notify(explain(e), "warning"); }
    }
    runtimes = loaded;
    // One profile failing to start never stops the others.
    for (const r of loaded) try { r.start(); } catch (e) { runtimes = runtimes.filter(x => x !== r); await r.stop(); fresh.ui.notify(`${r.id}: ${explain(e)}`, "warning"); }
  });
  pi.on("session_shutdown", shutdown);
  // Observation only: no automatic steering, abort, replay or new turn. Held mail is put back after settling.
  pi.on("message_end", event => { const message = handoffs.consumed(event.message); return message && { message }; });
  pi.on("agent_end", () => handoffs.ended());
  pi.on("agent_settled", (event, ctx) => handoffs.settled(event.aborted, ctx));
  // No input/idle/editor/context hooks: the human and peer messages use Pi's existing scheduling.
  pi.registerCommand("concourse-v3", { description: "help | status | refresh | answers | answer <messageId> | reconcile <messageId> [profile host/owner/agent] | collapse on|off; normal Pi mailbox",
    getArgumentCompletions: prefix => ["help", "status", "refresh", "answers", "answer ", "reconcile ", "collapse on", "collapse off"].filter(c => c.startsWith(prefix)).map(value => ({ value, label: value.trim() })),
    handler: async (args, fresh) => {
    if (args.trim() === "help") {
      fresh.ui.notify("/concourse-v3 help | status | refresh | answers | answer <messageId> | reconcile <messageId> | collapse on|off\nWith several profiles, status/refresh/answers can take host/owner/agent; answer/reconcile follow the original message.\nSetup (terminal from checkout root, not a slash command):\nFresh canonical signup uses the separate automatic LEGACY native-registration contract; the supporting issuer release and eligible account are required. Alternatively, --oauth-client-id PUBLIC_UID selects an operator-provisioned V3 public client. Ordinary DCR is legacy-only. Preserve old/uncertain drafts; never override a resumed client. Tokens/public IDs cannot grant membership. Browser callbacks must reach the CLI loopback listener.\nscript/concourse-v3 install\nscript/concourse-v3 join --agent my-agent [--organization SLUG] [--no-open] [--json]  (agent-first: checks, resumes or signs up; run it in the background)\nscript/concourse-v3 callback --url '<address>'  (when the approving browser is on another computer)\nscript/concourse-v3 signup --origin https://concourse.krishnan.ca --profile /absolute/path/concourse-v3/my-agent --agent my-agent [--oauth-client-id PUBLIC_UID] [--organization SLUG] [--no-open] [--json]\nscript/concourse-v3 signup --profile /absolute/path/concourse-v3/my-agent --resume [--organization SLUG]\nResume without --oauth-client-id. Unknown registration/code/card writes remain fenced, not retried.\nOAuth recovery (Linux Node24+, terminal only, not automatic): stop the existing consumer normally to release its lock; run explicit login with the existing profile, then resume the same session. Fresh consent uses the saved client; never clear tokens/config/ledger or replay an uncertain exchange.\nscript/concourse-v3 login --profile /absolute/path/concourse-v3/my-agent [--no-open] [--json]\nscript/concourse-v3 doctor --profile /absolute/path/concourse-v3/my-agent\nscript/concourse-v3 start --profile /absolute/path/concourse-v3/my-agent [-- normal Pi args]\nConnected is not ready. Outcomes use explicit reply tools, never turn-end completion.", "info");
      return;
    }
    const [verb = "", ...rest] = args.trim().split(/\s+/);
    const id = verb === "answer" || verb === "reconcile" ? rest.shift() ?? "" : undefined;
    let targets: Runtime[];
    try {
      attach(fresh);
      if (verb === "collapse") return collapse(rest[0]);
      targets = rest[0] ? [named(rest[0])] : runtimes;
      // Answers and reconciliation belong to the profile that sent the original message.
      if (id !== undefined) targets = [targets.find(r => r.sent(id)) ?? targets[0]];
    } catch (e) { fresh.ui.notify(explain(e), "warning"); return; }
    for (const r of targets) {
      try { await r.life.run(async () => {
        if (verb === "refresh") await r.refresh();
        else if (verb === "answers") r.notify(r.outbox.offers().map(o => `${o.messageId} task=${o.taskId ?? "direct"}`).join("\n") || "No pending answers");
        else if (verb === "answer") r.offerAnswer(id!);
        else if (verb === "reconcile") await r.outbox.reconcile(id!);
        else if (!verb || verb === "status") { r.status(); r.notify(r.report()); }
        else throw new SafeError("UNKNOWN_COMMAND_USE_CONCOURSE_V3_HELP");
      }); } catch (e) { if (r.life.alive()) r.notify(explain(e), "warning"); }
    }
  } });
  function collapse(choice: string | undefined): void {
    const first = runtimes[0];
    if (choice !== "on" && choice !== "off") { first.ctx.ui.notify(`Concourse messages are ${display.collapse ? "collapsed" : "expanded"}; use /concourse-v3 collapse on|off`, "info"); return; }
    for (const r of runtimes) r.files.write(DISPLAY_FILE, { collapse: choice === "on" });
    display = { collapse: choice === "on" };
    first.ctx.ui.notify(`Concourse messages ${choice === "on" ? "collapse to one line; the tool-expand key (Ctrl+O by default) shows them in full" : "show in full"}. Earlier messages redraw on the next expand toggle.`, "info");
  }
  type Params = Record<string, unknown>;
  const profile = Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "Profile host/owner/agent, as in the message label; required when several profiles are loaded" }));
  function tool(name: string, description: string, properties: Parameters<typeof Type.Object>[0], run: (r: Runtime, p: Params) => Promise<unknown>, readOnly = false, route = (p: Params) => one(p.profile as string | undefined)) {
    // A mail check mutates local queues, but still needs the post-result ownership fence below.
    const definition: ToolDefinition = { name: `concourse_v3_${name}`, label: `Concourse v3 ${name}`, description, ...(name === "reply" ? { promptGuidelines: [PEER_GUIDELINE] } : {}), parameters: Type.Object({ ...properties, profile }) as ToolDefinition["parameters"], outputSchema: Type.Object({ result: Type.Unknown() }), executionMode: "sequential", annotations: { readOnlyHint: readOnly && name !== "check", destructiveHint: name === "cancel", openWorldHint: true },
      // The profile is resolved before any intent is journaled; a refusal writes nothing.
      async execute(_id, p, _signal, _update, fresh) { attach(fresh); const r = route(p as Params); return r.life.run(async () => {
        const value = await run(r, p as Params);
        // Output only: preserve completed write receipts, including accepted-save warnings.
        // Every operation/HTTP/file guard still fences stale owners; unknown writes still throw.
        if (readOnly) r.life.check();
        return toolResult(name, value);
      }); },
      renderResult(r) { return new Text(r.content.filter(c => c.type === "text").map(c => c.text).join("\n"), 0, 0); },
    };
    tools.push(definition); pi.registerTool(definition);
  }
  const s = () => Type.String({ minLength: 1, maxLength: 2048 });
  const taskId = () => Type.String({ minLength: 1, maxLength: 2048, description: "Full task ID exactly as shown, never shortened" });
  // A shortened ID is refused before any intent is journaled or request is sent.
  const full = (id: unknown) => id === undefined ? undefined : fullTaskId(id as string);
  const handle = () => Type.String({ pattern: RECIPIENT_PATTERN, maxLength: 2048, description: "Agent handle owner/agent, e.g. ajent/reviews (not a URL)" });
  tool("find", "Discover permitted agents", { query: Type.Optional(s()) }, (r, p) => r.client.find(p.query as string | undefined), true);
  tool("send", "Send ordinary A2A correspondence. Write in plain, human-friendly language for a mixed audience (people and agents, technical or not). Use task_id only to continue a task you sent; use reply for a received task. Stable intent survives uncertainty; don't resend unknown writes. expect_reply=false suppresses unrequested terminal replies, not genuine input questions.", { to: handle(), parts: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1, maxItems: 100 }), expect_reply: Type.Optional(Type.Boolean()), task_id: Type.Optional(taskId()), context_id: Type.Optional(s()) }, async (r, p) => r.outbox.send(p.to as string, p.parts as ObjectValue[], p.expect_reply !== false, full(p.task_id), p.context_id as string | undefined));
  tool("get", "Read visible Task with raw history/artifacts", { task_id: taskId() }, async (r, p) => r.client.get(full(p.task_id)!), true);
  tool("list", "Read one bounded visible Task page", { page_token: Type.Optional(s()), status: Type.Optional(s()) }, (r, p) => r.client.list({ ...(p.page_token ? { pageToken: p.page_token as string } : {}), ...(p.status ? { status: p.status as string } : {}) }), true);
  tool("check", "Check mail; incoming messages use Pi's normal follow-up queue", {}, async r => { await r.refresh(); return { checked: true }; }, true);
  tool("cancel", "Sender CancelTask; never aborts Pi or tools", { to: handle(), task_id: taskId() }, async (r, p) => r.client.cancel(p.to as string, full(p.task_id)!));
  tool("reply", "Reply to a received Task in plain, human-friendly language for a mixed audience; no active Pi delivery is required. Set explicit outcome; no obligatory ACK, no CANCELED, no automatic completion on turn end. Goes back through the profile that received the Task.", { task_id: taskId(), state: Type.Union([Type.Literal("TASK_STATE_COMPLETED"), Type.Literal("TASK_STATE_FAILED"), Type.Literal("TASK_STATE_REJECTED"), Type.Literal("TASK_STATE_INPUT_REQUIRED"), Type.Literal("TASK_STATE_WORKING")]), parts: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 100 })), artifacts: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 20 })) }, (r, p) => {
    return r.replies.send(p.task_id as string, { state: p.state as string, parts: p.parts as ObjectValue[] | undefined, artifacts: p.artifacts as ObjectValue[] | undefined });
  }, false, p => replier(full(p.task_id)!, p.profile as string | undefined));
  tool("presence", "Network-agent presence query; connection is not readiness", { agent: s() }, (r, p) => r.client.network({ operation: "presence", agent: p.agent as string }), true);
  tool("receipt", "Delivery query for original send; never replace an uncertain message", { message_id: s(), task_id: Type.Optional(taskId()), recipient: Type.Optional(s()) }, async (r, p) => r.client.network({ operation: "delivery", messageId: p.message_id as string, ...(p.task_id ? { taskId: full(p.task_id)! } : { recipient: p.recipient as string }) }), true);
}
export default function (pi: ExtensionAPI): void { install(pi); }
