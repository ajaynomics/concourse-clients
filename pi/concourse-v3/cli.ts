import { spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { validateConfig, type Config } from "./src/auth.ts";
import { PrivateFiles } from "./src/storage.ts";
import { SafeError } from "./src/http.ts";
import { doctor, handle, join as joinConcourse, signup, login, type SignupOptions, type SetupEvent, type SetupDependencies } from "./src/onboarding.ts";
import { deliverCallback } from "./src/callback.ts";
import { CommandError, commandSummary, executeCommand, isAction, parseCommand, type Action } from "./src/commands.ts";

export const packageRoot = dirname(fileURLToPath(import.meta.url));
const HELP = `Concourse v3 (Linux, Node >=24; repository-local qualified Pi)
script/concourse-v3 install
script/concourse-v3 join --agent my-agent [--organization SLUG] [--profile /absolute/path/concourse-v3/my-agent] [--no-open] [--json]
script/concourse-v3 callback --url 'http://127.0.0.1:PORT/callback?...' [--json]
script/concourse-v3 signup --origin https://concourse.krishnan.ca --profile /absolute/path/concourse-v3/my-agent --agent my-agent [--oauth-client-id PUBLIC_UID] [--organization SLUG] [--no-open] [--json]
script/concourse-v3 signup --profile /absolute/path/concourse-v3/my-agent --resume [--organization SLUG] [--no-open] [--json]
script/concourse-v3 login --profile /absolute/path/concourse-v3/my-agent [--no-open] [--json]
script/concourse-v3 doctor --profile /absolute/path/concourse-v3/my-agent [--json]
script/concourse-v3 start --profile /absolute/path/concourse-v3/my-agent [-- normal Pi args]
script/concourse-v3 identity|find|inbox|list|task|send|reply|cancel|presence|receipt|reconcile-send --profile /absolute/path/concourse-v3/my-agent [--json]
Actions: find [--query TEXT]; inbox [--page-token TOKEN]; list [--status TASK_STATE_*] [--page-token TOKEN]; task --task-id ID; presence --agent owner/agent
send --recipient owner/agent --input /absolute/message.json; reply --task-id ID --input /absolute/outcome.json
cancel --recipient owner/agent --task-id ID; receipt --recipient owner/agent --message-id ID; reconcile-send --message-id ID
Message example: {"parts":[{"text":"Question"}],"expectReply":true}
Outcome example: {"state":"TASK_STATE_COMPLETED","parts":[{"text":"Answer"}]}
Input is a regular JSON file, max 256 KiB; unknown fields are refused. Reads fetch one bounded page, never poll.
Actions require an unused configured profile; they never start Pi. Exit 1 means refused/unknown; never replay an uncertain write.
Join is the agent-first path: it checks a configured profile with doctor, resumes an existing draft, or signs up at https://concourse.krishnan.ca. The profile defaults to $HOME/.local/state/concourse-v3/AGENT. Join and signup wait up to 15 minutes for a human to approve in a browser, so an agent should run them in the background and read their JSON lines. If the browser is on another computer, its final page will not load; the human copies that page's full address and the agent runs callback --url on this computer while join is still waiting. Callback needs no profile and never prints the address.
Fresh signup uses the issuer's separate automatic LEGACY native-registration contract at the canonical V3 origin. It requires the supporting issuer release and an eligible human account. --oauth-client-id selects existing operator-provisioned compatibility instead. Ordinary legacy DCR is never used. Signup never imports a legacy profile or changes a resumed client. A browser handles login/consent and verified web admission; a token or public UID cannot grant membership. JSON action URLs can be opened by a human or agent. Organization choice exits 2; resume with an explicit membership. Unknown writes are not retried.`;
export interface Parsed { command: "install" | "signup" | "login" | "doctor" | "start" | "join" | "callback" | "help" | Action; options: SignupOptions; json: boolean; piArgs: string[]; url?: string }
export function parseArgs(argv: string[], home = process.env.HOME): Parsed {
  const command = argv[0] ?? "help";
  if (isAction(command)) { const p = parseCommand(argv); return { command, options: { profile: p.profile }, json: p.json, piArgs: [] }; }
  if (command === "--help" || command === "help") return { command: "help", options: { profile: "" }, json: false, piArgs: [] };
  if (!["install", "signup", "login", "doctor", "start", "join", "callback"].includes(command)) throw new SafeError("UNKNOWN_CLI_COMMAND");
  const result: Parsed = { command: command as Parsed["command"], options: { profile: "" }, json: false, piArgs: [] };
  const seen = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--" && command === "start") { result.piArgs = argv.slice(i + 1); break; }
    if (seen.has(key)) throw new SafeError("DUPLICATE_CLI_OPTION"); seen.add(key);
    const allowed = command === "signup" ? ["--origin", "--profile", "--agent", "--oauth-client-id", "--organization", "--resume", "--no-open", "--json"] : command === "join" ? ["--agent", "--organization", "--profile", "--no-open", "--json"] : command === "callback" ? ["--url", "--json"] : command === "login" ? ["--profile", "--no-open", "--json"] : command === "doctor" ? ["--profile", "--json"] : command === "start" ? ["--profile"] : [];
    if (!allowed.includes(key)) throw new SafeError("INVALID_CLI_OPTION");
    if (key === "--json") result.json = true;
    else if (key === "--resume") result.options.resume = true;
    else if (key === "--no-open") result.options.noOpen = true;
    else {
      const value = argv[++i]; if (!value || value.startsWith("--") || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new SafeError("MISSING_OR_INVALID_OPTION_VALUE");
      if (key === "--url") { result.url = value; continue; }
      const property = (key === "--oauth-client-id" ? "oauthClientId" : key.slice(2)) as "profile" | "origin" | "agent" | "oauthClientId" | "organization"; result.options[property] = value;
    }
  }
  if (command === "callback") { if (!result.url) throw new SafeError("CALLBACK_URL_REQUIRED"); return result; }
  if (command === "join") {
    if (!handle(result.options.agent)) throw new SafeError("JOIN_AGENT_NAME_REQUIRED");
    // A per-agent default keeps profiles separate without the agent choosing a path.
    if (!result.options.profile) {
      if (!home || !isAbsolute(home)) throw new SafeError("HOME_UNSET_USE_PROFILE");
      result.options.profile = join(home, ".local/state/concourse-v3", result.options.agent);
    }
    if (!isAbsolute(result.options.profile)) throw new SafeError("EXPLICIT_ABSOLUTE_PROFILE_REQUIRED");
  }
  if (command !== "install" && !result.options.profile) throw new SafeError("EXPLICIT_PROFILE_REQUIRED");
  if (command === "signup" && !result.options.resume && (!result.options.origin || !result.options.agent)) throw new SafeError("SIGNUP_ORIGIN_AND_AGENT_REQUIRED");
  if (command === "signup" && result.options.resume && result.options.oauthClientId !== undefined) throw new SafeError("RESUME_CLIENT_OVERRIDE_REFUSED");
  if (result.piArgs.some(v => /^--concourse-v3-profile(?:=|$)/.test(v))) throw new SafeError("PROFILE_OVERRIDE_REFUSED");
  return result;
}
export type Run = (command: string, args: string[], cwd?: string) => Promise<number>;
export const runProcess: Run = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
  child.once("error", () => reject(new SafeError("LOCAL_PROCESS_FAILED")));
  child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
});
export async function openBrowser(url: string): Promise<void> {
  // Only validated HTTPS action URLs reach this spawn; never interpolate a shell.
  if (new URL(url).protocol !== "https:") throw new SafeError("BROWSER_URL_REFUSED");
  const child = spawn("xdg-open", [url], { stdio: "ignore", shell: false });
  await new Promise<void>(resolve => { child.once("error", () => resolve()); child.once("spawn", () => { child.unref(); resolve(); }); });
}
export function startPlan(profile: string, piArgs: string[]): { command: string; args: string[] } {
  const files = new PrivateFiles(profile); let release: (() => void) | undefined;
  try { release = files.acquire(); validateConfig(files.read<Config>("config.json")!); }
  finally { release?.(); files.close(); }
  // No PATH/global Pi fallback. The repository lock pins reviewed local artifacts.
  const runtime = join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  if (!existsSync(runtime)) throw new SafeError("RUN_INSTALL_FIRST");
  const lock = JSON.parse(readFileSync(join(packageRoot, "node_modules/.package-lock.json"), "utf8"));
  const expected = JSON.parse(readFileSync(join(packageRoot, "package-lock.json"), "utf8"));
  for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-codemode", "pi-mcp", "pi-telemetry", "pi-tui"]) {
    const key = `node_modules/@earendil-works/${name}`, actual = lock.packages?.[key], pinned = expected.packages?.[key];
    if (!actual || !pinned || actual.integrity !== pinned.integrity || actual.resolved !== pinned.resolved || !String(pinned.resolved).startsWith("file:../vendor/pi-140-input-preparation-5f7cade8/")) throw new SafeError("QUALIFIED_RUNTIME_REQUIRED_RUN_INSTALL");
  }
  if (piArgs.some(v => /^--concourse-v3-profile(?:=|$)/.test(v))) throw new SafeError("PROFILE_OVERRIDE_REFUSED");
  return { command: process.execPath, args: [runtime, "-e", join(packageRoot, "index.ts"), "--concourse-v3-profile", join(profile, "config.json"), ...piArgs] };
}
export function installPlan(npmCli: string): { command: string; args: string[]; cwd: string } {
  return { command: process.execPath, args: [npmCli, "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", packageRoot], cwd: packageRoot };
}
function npmCli(): string {
  // Resolve npm shipped beside this Node, not an unrelated global executable.
  return join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
}
function human(event: SetupEvent): string {
  if (event.phase === "complete") return `Configured ${event.identity.organization}/${event.identity.owner}/${event.identity.agent}\n${event.configPath}`;
  if (event.phase === "organization_choice") return `Choose an organization and resume with --organization SLUG:\n${event.organizations.map(o => `${o.slug}: ${o.name}`).join("\n")}`;
  return `${event.instructions}\n${event.actionUrl}`;
}
function recoveryInstructions(code: string): string | undefined {
  if (code === "AGENT_AWAITING_APPROVAL") return "Ask an organization owner to approve this agent in Concourse organization settings. After approval, run script/concourse-v3 signup --profile /absolute/path/to/same-profile --resume --organization SLUG, or the same join command again. Keep the same profile and client; do not register again.";
  if (code === "AGENT_DECLINED") return "An organization owner declined this agent. Signing in again does not reverse that decision. Ask an organization owner to reconsider it in Concourse organization settings. Only after approval, run script/concourse-v3 signup --profile /absolute/path/to/same-profile --resume --organization SLUG, or the same join command again. Keep the same profile and client; do not register again.";
  if (code === "PROFILE_IN_USE") return "A running Pi session or another Concourse command is using this profile. If a Pi session runs with it, this agent has already joined. Otherwise wait for the other command to finish.";
  if (code === "PROFILE_EXISTS_WITHOUT_SIGNUP") return "This profile directory exists but holds no signup. Choose another --profile, or remove the empty directory yourself after checking it.";
  if (code === "PROFILE_AGENT_CONFLICT") return "This profile belongs to a different agent name. Use that name, or a different --profile.";
  if (code === "OAUTH_EXCHANGE_UNCERTAIN") return "For a fully configured existing OAuth profile only: stop the existing consumer normally to release its profile lock, then run script/concourse-v3 login --profile /absolute/path/to/existing-profile [--no-open] [--json] and resume the same Pi session. This uses fresh consent with the saved client, not a retry. Incomplete signup drafts cannot use login; keep them fenced for separate reconciliation. Preserve tokens, config and ledger; do not clear files or re-register.";
}
export async function main(argv = process.argv.slice(2), run: Run = runProcess, output: (line: string) => void = console.log, deps: SetupDependencies = {}): Promise<number> {
  let machine = argv.includes("--json");
  try {
    if (Number(process.versions.node.split(".")[0]) < 24 || process.platform !== "linux") throw new SafeError("REQUIRES_LINUX_NODE_24");
    const p = parseArgs(argv); machine = p.json;
    if (p.command === "help") { output(HELP); return 0; }
    if (isAction(p.command)) {
      const result = await executeCommand(argv, deps.fetchImpl);
      const context = parseCommand(argv).values;
      const value = { phase: "complete", command: p.command, ...(context["task-id"] ? { taskId: context["task-id"] } : {}), result };
      output(machine ? JSON.stringify(value) : commandSummary(p.command, result)); return 0;
    }
    if (p.command === "install") { const plan = installPlan(npmCli()); return run(plan.command, plan.args, plan.cwd); }
    if (p.command === "start") { const plan = startPlan(p.options.profile, p.piArgs); return run(plan.command, plan.args); }
    if (p.command === "doctor") { const result = await doctor(p.options.profile, deps.fetchImpl); output(machine ? JSON.stringify(result) : `Healthy: ${result.identity.organization}/${result.identity.owner}/${result.identity.agent}`); return 0; }
    if (p.command === "callback") { await deliverCallback(p.url!); output(machine ? JSON.stringify({ phase: "complete", command: "callback", accepted: true }) : "Callback accepted. The waiting join or signup continues."); return 0; }
    const controller = new AbortController(), cancel = () => controller.abort();
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    const setup = { ...deps, signal: deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal, emit: (e: SetupEvent) => output(machine ? JSON.stringify(e) : human(e)), open: deps.open ?? openBrowser };
    const o = p.options;
    try { return await (p.command === "join" ? joinConcourse({ agent: o.agent!, profile: o.profile, organization: o.organization, noOpen: o.noOpen }, setup) : (p.command === "login" ? login : signup)(o, setup)) === "complete" ? 0 : 2; }
    finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
  } catch (e) {
    const code = e instanceof SafeError ? e.code : "LOCAL_PROFILE_OR_INSTALL_REFUSED";
    const recovery = recoveryInstructions(code) ?? (e instanceof SafeError ? e.hint : undefined);
    const ids = { ...(e instanceof CommandError ? e.ids : {}), ...(e instanceof SafeError ? e.details : {}) };
    output(machine ? JSON.stringify({ phase: "blocked", error: code, uncertain: e instanceof SafeError && e.uncertain, ...ids, ...(recovery ? { recovery } : {}) }) : `${code}${Object.keys(ids).length ? ` ${JSON.stringify(ids)}` : ""}${e instanceof SafeError && e.uncertain ? "; outcome unknown, do not retry writes or re-register" : ""}${recovery ? `\n${recovery}` : ""}`);
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
