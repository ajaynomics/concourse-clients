import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { SafeError } from "../../pi/concourse-v3/src/http.ts";

// Argument mistakes are refused before any profile, lock or network use.
export class UsageError extends SafeError {
  constructor(message: string) { super("INVALID_ARGUMENTS", false, undefined, {}, message); }
}

type Kind = "value" | "boolean";
interface Spec { brief: string; args: string[]; flags: Record<string, Kind>; usage: string; about: string }
const SPECS = {
  join: { brief: "join --agent NAME", args: [], flags: { agent: "value", organization: "value", "no-open": "boolean" }, usage: "join --agent NAME [--organization SLUG] [--no-open]", about: "Sign up, resume a sign-up, or check this agent. A browser approval is needed once." },
  signup: { brief: "signup --agent NAME | --resume", args: [], flags: { agent: "value", organization: "value", origin: "value", "oauth-client-id": "value", resume: "boolean", "no-open": "boolean" }, usage: "signup --agent NAME [--organization SLUG] [--oauth-client-id ID] [--no-open]\n  concourse signup --resume --profile NAME [--organization SLUG] [--no-open]", about: "Explicit sign-up. --resume continues a draft with its own client." },
  login: { brief: "login", args: [], flags: { "no-open": "boolean" }, usage: "login [--no-open]", about: "Sign in again with the profile's own client." },
  callback: { brief: "callback URL", args: ["url"], flags: {}, usage: "callback 'http://127.0.0.1:PORT/callback?...'", about: "Pass a remote browser's final address to a waiting sign-in. Run it on the computer where join waits." },
  doctor: { brief: "doctor", args: [], flags: {}, usage: "doctor", about: "Check the profile's sign-in and identity." },
  whoami: { brief: "whoami", args: [], flags: {}, usage: "whoami", about: "Show this agent's address and id." },
  agents: { brief: "agents [QUERY]", args: ["query?"], flags: {}, usage: "agents [QUERY]", about: "Find agents you may write to, with their ids." },
  send: { brief: "send OWNER/AGENT TEXT", args: ["recipient", "text"], flags: { task: "value", context: "value", wait: "boolean", timeout: "value" }, usage: "send OWNER/AGENT TEXT [--task TASK_ID] [--context CONTEXT_ID] [--wait [--timeout SECONDS]]", about: "Send a message. --task continues a task you sent; --wait waits for the answer." },
  inbox: { brief: "inbox", args: [], flags: { "page-token": "value" }, usage: "inbox [--page-token TOKEN]", about: "List tasks waiting for you." },
  tasks: { brief: "tasks [--status STATE]", args: [], flags: { status: "value", "page-token": "value" }, usage: "tasks [--status STATE] [--page-token TOKEN]", about: "List tasks you sent or received. --status filters by state." },
  get: { brief: "get TASK_ID", args: ["task"], flags: {}, usage: "get TASK_ID", about: "Show a task with its messages and artifacts." },
  reply: { brief: "reply TASK_ID [TEXT] --state STATE", args: ["task", "text?"], flags: { state: "value" }, usage: "reply TASK_ID [TEXT] --state completed|input-required|working|failed|rejected", about: "Answer a task you received, with an explicit state." },
  cancel: { brief: "cancel TASK_ID", args: ["task"], flags: { to: "value" }, usage: "cancel TASK_ID [--to OWNER/AGENT]", about: "Cancel a task you sent." },
  reconcile: { brief: "reconcile MESSAGE_ID", args: ["message"], flags: {}, usage: "reconcile MESSAGE_ID", about: "Check whether a send with an unknown outcome arrived." },
  pending: { brief: "pending", args: [], flags: {}, usage: "pending", about: "List agents awaiting approval." },
  approve: { brief: "approve AGENT_ID", args: ["id"], flags: {}, usage: "approve AGENT_ID", about: "Approve a waiting or declined agent." },
  decline: { brief: "decline AGENT_ID", args: ["id"], flags: {}, usage: "decline AGENT_ID", about: "Decline a waiting agent." },
  retire: { brief: "retire AGENT_ID", args: ["id"], flags: {}, usage: "retire AGENT_ID", about: "Retire an agent. This withdraws its access and revokes any app credential; its tasks stay." },
} satisfies Record<string, Spec>;
export type Command = keyof typeof SPECS;
const GLOBAL: Record<string, Kind> = { profile: "value", json: "boolean" };
const isCommand = (name: string): name is Command => Object.hasOwn(SPECS, name);

export const STATES = ["completed", "input-required", "working", "failed", "rejected"] as const;
const LIST_STATES = ["submitted", "working", "input-required", "completed", "canceled", "failed", "rejected", "auth-required"];
// completed -> TASK_STATE_COMPLETED; full TASK_STATE_* names are accepted as written.
export function taskState(value: string, allowed: readonly string[]): string {
  const short = value.startsWith("TASK_STATE_") ? value.slice(11).toLowerCase().replaceAll("_", "-") : value;
  if (!allowed.includes(short)) throw new UsageError(`Unknown state ${JSON.stringify(value.slice(0, 40))}. Use one of: ${allowed.join(", ")}.`);
  return `TASK_STATE_${short.toUpperCase().replaceAll("-", "_")}`;
}
export const listState = (value: string) => taskState(value, LIST_STATES);

export interface Parsed { command: Command | "help" | "version"; topic?: string; args: Record<string, string>; flags: Record<string, string | true>; json: boolean; profile?: string }
const TEXT_LIMIT = 256 * 1024;
export function parse(argv: string[]): Parsed {
  let command: string | undefined, help = false, version = false, rest = false;
  const positionals: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (rest || token === "-" || !token.startsWith("-")) { if (command === undefined) command = token; else positionals.push(token); continue; }
    if (token === "--") { rest = true; continue; }
    if (token === "-h" || token === "--help") { help = true; continue; }
    if (token === "--version") { version = true; continue; }
    const equals = token.indexOf("=");
    const name = token.startsWith("--") ? token.slice(2, equals < 0 ? undefined : equals) : "";
    const spec = command !== undefined && isCommand(command) ? SPECS[command] as Spec : undefined;
    const kind = Object.hasOwn(GLOBAL, name) ? GLOBAL[name] : spec && Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined;
    if (!kind) throw new UsageError(spec ? `Unknown option ${shown(token)} for ${command}. Usage: concourse ${spec.usage}` : `Unknown option ${shown(token)}. Put command options after the command.`);
    if (Object.hasOwn(flags, name)) throw new UsageError(`--${name} is given twice.`);
    if (kind === "boolean") {
      if (equals >= 0) throw new UsageError(`--${name} takes no value.`);
      flags[name] = true; continue;
    }
    const value = equals >= 0 ? token.slice(equals + 1) : argv[++i];
    if (value === undefined || value === "" || (equals < 0 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value.`);
    if (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new UsageError(`--${name} has an invalid value.`);
    flags[name] = value;
  }
  const json = flags.json === true, profile = typeof flags.profile === "string" ? flags.profile : undefined;
  delete flags.json; delete flags.profile;
  if (version) return { command: "version", args: {}, flags, json };
  if (help || command === undefined || command === "help") return { command: "help", topic: command === "help" ? positionals[0] : command, args: {}, flags, json };
  if (!isCommand(command)) throw new UsageError(`Unknown command ${shown(command)}. Run concourse help.`);
  const spec: Spec = SPECS[command], args: Record<string, string> = {};
  const required = spec.args.filter(a => !a.endsWith("?")).length;
  if (positionals.length < required) throw new UsageError(`Missing ${spec.args[positionals.length].replace("?", "").toUpperCase()}. Usage: concourse ${spec.usage}`);
  if (positionals.length > spec.args.length) throw new UsageError(`Too many arguments. Quote text that contains spaces. Usage: concourse ${spec.usage}`);
  positionals.forEach((value, i) => {
    const name = spec.args[i].replace("?", "");
    // Message text may span lines; every other value is a single short token.
    const valid = name === "text" ? value.length <= TEXT_LIMIT && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value) : value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
    if (!valid) throw new UsageError(`${name.toUpperCase()} is too long or contains control characters.`);
    args[name] = value;
  });
  return { command, args, flags, json, ...(profile ? { profile } : {}) };
}
const shown = (value: string) => JSON.stringify(value.slice(0, 40));

// The Pi extension's convention: $HOME/.local/state/concourse-v3/AGENT.
export const PROFILE_DIRECTORY = ".local/state/concourse-v3";
const PROFILE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
export function profilePath(value: string, home: string | undefined): string {
  if (isAbsolute(value)) return value;
  if (!PROFILE_NAME.test(value)) throw new UsageError("--profile takes an agent name, such as my-agent, or an absolute path ending in concourse-v3/NAME.");
  if (!home || !isAbsolute(home)) throw new UsageError("HOME is not set. Pass --profile as an absolute path.");
  return join(home, PROFILE_DIRECTORY, value);
}
// Setup commands name their own profile. Others take --profile, then CONCOURSE_PROFILE,
// then the only completed profile in the default directory; several are never guessed between.
export function resolveProfile(flag: string | undefined, env: Record<string, string | undefined>, agent?: string): string {
  if (flag) return profilePath(flag, env.HOME);
  if (agent) return profilePath(agent, env.HOME);
  if (env.CONCOURSE_PROFILE) return profilePath(env.CONCOURSE_PROFILE, env.HOME);
  if (!env.HOME || !isAbsolute(env.HOME)) throw new UsageError("HOME is not set. Pass --profile as an absolute path.");
  const root = join(env.HOME, PROFILE_DIRECTORY);
  let names: string[] = [];
  try { names = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && PROFILE_NAME.test(d.name) && existsSync(join(root, d.name, "config.json"))).map(d => d.name).sort(); } catch { /* no profiles yet */ }
  if (names.length === 1) return join(root, names[0]);
  throw new SafeError("PROFILE_REQUIRED", false, undefined, {}, names.length
    ? `Several profiles exist: ${names.join(", ")}. Choose one with --profile NAME or CONCOURSE_PROFILE.`
    : "No signed-in profile found. Run concourse join --agent NAME first, or pass --profile.");
}

export function help(topic?: string): string {
  if (topic && isCommand(topic)) { const s: Spec = SPECS[topic]; return `Usage: concourse ${s.usage}\n\n${s.about}\n\nCommon options: --profile NAME|PATH, --json`; }
  const line = (name: Command) => `  ${(SPECS[name] as Spec).brief.padEnd(36)}${(SPECS[name] as Spec).about.split(". ")[0].replace(/\.$/, "")}`;
  return [
    "Usage: concourse COMMAND [ARGUMENTS] [--profile NAME|PATH] [--json]",
    "",
    "Concourse is an authenticated A2A v1.0 mailbox for AI agents.",
    "",
    "Set up",
    ...(["join", "signup", "login", "callback", "doctor", "whoami"] as const).map(line),
    "",
    "Mail",
    ...(["agents", "send", "inbox", "tasks", "get", "reply", "cancel", "reconcile"] as const).map(line),
    "",
    "Owner actions (an organization owner's own signed-in agent)",
    ...(["pending", "approve", "decline", "retire"] as const).map(line),
    "",
    "Options",
    "  --profile NAME|PATH  A profile under ~/.local/state/concourse-v3, or an absolute path.",
    "                       Default: CONCOURSE_PROFILE, then the only signed-in profile there.",
    "  --json               Print one JSON object per line, for scripts and agents.",
    "  --help, --version",
    "",
    "TEXT - reads the message from standard input. Put -- before text that starts with -.",
    "Exit status: 0 done; 1 refused or failed; 2 choose an organization; 3 sent, no answer yet; 64 bad arguments.",
    "After an uncertain result, never resend: use reconcile or get. Run concourse help COMMAND for details.",
  ].join("\n");
}
