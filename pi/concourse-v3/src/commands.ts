import { openSync, closeSync, constants, fstatSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { TokenClient, validateConfig, type Config } from "./auth.ts";
import { Client, fullTaskId, qualifiedRecipient, validOutcome } from "./client.ts";
import { PrivateFiles, FileJournal } from "./storage.ts";
import { Outbox } from "./outgoing.ts";
import { Replies } from "./replies.ts";
import { SafeError, type ErrorDetails, type Fetch } from "./http.ts";
import { object, type ObjectValue, type Outcome } from "./types.ts";

const options = {
  identity: [], find: ["query"], inbox: ["page-token"], list: ["status", "page-token"], task: ["task-id"],
  send: ["recipient", "input"], reply: ["task-id", "input"], cancel: ["recipient", "task-id"],
  presence: ["agent"], receipt: ["recipient", "message-id"], "reconcile-send": ["message-id"],
} as const;
export type Action = keyof typeof options;
export interface Command { command: Action; profile: string; json: boolean; values: Record<string, string> }
export const isAction = (name: string): name is Action => Object.hasOwn(options, name);
export function parseCommand(argv: string[]): Command {
  const name = argv[0]; if (!isAction(name)) throw new SafeError("UNKNOWN_CLI_COMMAND");
  const values: Record<string, string> = {}, seen = new Set<string>(); let json = false;
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (seen.has(key)) throw new SafeError("DUPLICATE_CLI_OPTION"); seen.add(key);
    if (key === "--json") { json = true; continue; }
    if (!["--profile", ...options[name].map(k => `--${k}`)].includes(key)) throw new SafeError("INVALID_CLI_OPTION");
    const value = argv[++i];
    if (!value || value.startsWith("--") || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw new SafeError("MISSING_OR_INVALID_OPTION_VALUE");
    values[key.slice(2)] = value;
  }
  if (!values.profile || !isAbsolute(values.profile)) throw new SafeError("EXPLICIT_ABSOLUTE_PROFILE_REQUIRED");
  for (const key of options[name]) if (!["query", "page-token", "status"].includes(key) && !values[key]) throw new SafeError("MISSING_COMMAND_OPTION");
  if (values.status && !["SUBMITTED", "WORKING", "INPUT_REQUIRED", "COMPLETED", "CANCELED", "FAILED", "REJECTED", "AUTH_REQUIRED"].some(s => values.status === `TASK_STATE_${s}`)) throw new SafeError("INVALID_TASK_STATUS");
  for (const key of ["recipient", "agent"]) if (values[key]) qualifiedRecipient(values[key]);
  for (const key of ["task-id", "message-id"]) if (values[key] && [".", ".."].includes(values[key])) throw new SafeError("INVALID_IDENTIFIER");
  if (values["task-id"]) fullTaskId(values["task-id"]);
  if (values.input && !isAbsolute(values.input)) throw new SafeError("ABSOLUTE_INPUT_FILE_REQUIRED");
  return { command: name, profile: values.profile, json, values };
}
function keys(value: unknown, allowed: string[]): asserts value is ObjectValue {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new SafeError("INVALID_PAYLOAD_FIELDS");
}
function parts(value: unknown): asserts value is ObjectValue[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new SafeError("INVALID_PARTS");
  for (const p of value) {
    keys(p, ["text", "data"]);
    if (Object.keys(p).length !== 1 || !(typeof p.text === "string" && p.text.trim() || object(p.data))) throw new SafeError("INVALID_PART");
  }
}
export function validatePayload(command: "send" | "reply", value: unknown): ObjectValue {
  keys(value, command === "send" ? ["parts", "expectReply", "taskId", "contextId"] : ["state", "parts", "artifacts"]);
  if (command === "send") {
    parts(value.parts);
    if (value.expectReply !== undefined && typeof value.expectReply !== "boolean") throw new SafeError("INVALID_EXPECT_REPLY");
    for (const key of ["taskId", "contextId"]) if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key].trim() || value[key].length > 2048 || [".", ".."].includes(value[key]) || /[\x00-\x1f\x7f]/.test(value[key]))) throw new SafeError("INVALID_IDENTIFIER");
    if (value.taskId !== undefined) fullTaskId(value.taskId as string);
  } else {
    if (value.parts !== undefined) parts(value.parts);
    if (value.artifacts !== undefined) {
      if (!Array.isArray(value.artifacts) || value.artifacts.length > 20) throw new SafeError("INVALID_ARTIFACTS");
      for (const artifact of value.artifacts) {
        keys(artifact, ["name", "description", "parts", "metadata", "extensions"]);
        if (artifact.extensions !== undefined && (!Array.isArray(artifact.extensions) || !artifact.extensions.every(v => typeof v === "string"))) throw new SafeError("INVALID_ARTIFACT");
        for (const k of ["name", "description"]) if (artifact[k] !== undefined && artifact[k] !== null && typeof artifact[k] !== "string") throw new SafeError("INVALID_ARTIFACT");
        if (artifact.metadata !== undefined && !object(artifact.metadata)) throw new SafeError("INVALID_ARTIFACT");
        parts(artifact.parts);
      }
    }
    validOutcome(value as unknown as Outcome);
  }
  return value;
}
// A regular file only: bounded allocation, no symlink/FIFO waits or stdin daemon.
function payload(path: string, command: "send" | "reply"): ObjectValue {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 256 * 1024) throw new SafeError("PAYLOAD_FILE_LIMIT");
    const bytes = Buffer.alloc(256 * 1024 + 1); let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
    if (size > 256 * 1024) throw new SafeError("PAYLOAD_FILE_LIMIT");
    let value: unknown; try { value = JSON.parse(bytes.subarray(0, size).toString("utf8")); } catch { throw new SafeError("INVALID_PAYLOAD_JSON"); }
    return validatePayload(command, value);
  } finally { closeSync(fd); }
}
export class CommandError extends SafeError {
  constructor(code: string, uncertain: boolean, readonly ids: Record<string, string>, details: ErrorDetails = {}, hint?: string) { super(code, uncertain, undefined, details, hint); }
}
// Human mode never renders peer content or terminal controls. JSON retains the full result.
export function commandSummary(command: string, result: unknown): string {
  const value = object(result) ? result : {};
  const target = object(value.result) ? value.result : object(value.task) ? value.task : value;
  const ids = Object.fromEntries(["messageId", "id", "taskId"].flatMap(k => typeof value[k] === "string" ? [[k, value[k]]] : typeof target[k] === "string" ? [[k, target[k]]] : []));
  if (object(target.status) && typeof target.status.state === "string") ids.state = target.status.state;
  return `${command}: success${Object.keys(ids).length ? ` ${JSON.stringify(ids)}` : ""}${Array.isArray(value.tasks) ? ` (${value.tasks.length} tasks; next page: ${!!value.nextPageToken})` : ""}${typeof value.warning === "string" ? "; accepted, local save failed; do not repeat" : ""}; use --json for full result`;
}
export async function executeCommand(argv: string[], fetchImpl: Fetch = fetch): Promise<unknown> {
  const p = parseCommand(argv), v = p.values;
  const body = p.command === "send" || p.command === "reply" ? payload(v.input, p.command) : undefined;
  const files = new PrivateFiles(p.profile); let release: (() => void) | undefined;
  try {
    try { release = files.acquire(); } catch { throw new SafeError("PROFILE_BUSY_OR_LOCK_UNAVAILABLE"); }
    const config = validateConfig(files.read<Config>("config.json")!);
    const guard = () => { if (!files.ownsConsumer()) throw new SafeError("PROFILE_LOCK_LOST"); };
    const tokens = new TokenClient(config, files, fetchImpl, Date.now, guard);
    const client = new Client(config, () => tokens.token(), fetchImpl, () => files.ownsConsumer());
    const journal = new FileJournal(files);
    const ids: Record<string, string> = { ...(v.recipient ? { recipient: v.recipient } : {}), ...(v["task-id"] || body?.taskId ? { taskId: (v["task-id"] || body!.taskId) as string } : {}) };
    let attempted = false;
    const outbox = new Outbox(journal, {
      send: (...args) => { attempted = true; ids.messageId = args[1]; return client.send(...args); },
      get: id => client.get(id), network: data => client.network(data),
    }, guard);
    try {
    switch (p.command) {
      case "identity": return await client.identity();
      case "find": return await client.find(v.query);
      case "inbox": return await client.inbox(v["page-token"]);
      case "list": return await client.list({ ...(v.status ? { status: v.status } : {}), ...(v["page-token"] ? { pageToken: v["page-token"] } : {}) });
      case "task": return await client.get(v["task-id"]);
      case "presence": return await client.network({ operation: "presence", agent: v.agent });
      case "receipt": return await client.network({ operation: "delivery", recipient: v.recipient, messageId: v["message-id"] });
      case "send": return await outbox.send(v.recipient, body!.parts as ObjectValue[], body!.expectReply as boolean | undefined, body!.taskId as string | undefined, body!.contextId as string | undefined);
      case "reply": return await new Replies(journal, { reply: (...args) => { attempted = true; return client.reply(...args); }, get: id => client.get(id) }, guard).send(v["task-id"], body as unknown as Outcome);
      case "cancel": attempted = true; return await client.cancel(v.recipient, v["task-id"]);
      case "reconcile-send": {
        await outbox.reconcile(v["message-id"]);
        const o = journal.load().outgoing[v["message-id"]];
        return { messageId: o.messageId, phase: o.phase, taskId: o.taskId, resultType: o.resultType, directResultUnavailable: o.directResultUnavailable };
      }
    }
    } catch (e) {
      if (!["send", "reply", "cancel"].includes(p.command)) throw e;
      // These codes are only raised for definite refusals: the server answered and accepted nothing.
      const refused = e instanceof SafeError && !e.uncertain && (!!e.status && e.status < 500 || ["SEND_REFUSED", "REPLY_REFUSED", "CANCEL_REFUSED", "TASK_ALREADY_FINISHED", "REPLY_REQUIRED"].includes(e.code));
      throw e instanceof SafeError ? new CommandError(e.code, attempted && !refused, ids, e.details, e.hint) : new CommandError("LOCAL_WRITE_BOOKKEEPING_FAILED", attempted, ids);
    }
  } finally { release?.(); files.close(); }
}
