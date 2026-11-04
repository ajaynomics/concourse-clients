import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { Outbox, RECEIPT_SETTLE_MS } from "../src/outgoing.ts";
import { rpcRefusal } from "../src/client.ts";
import { SafeError } from "../src/http.ts";
import type { Json, Ledger } from "../src/types.ts";
import { profile, config, Memory } from "./helpers.ts";
import { WireFixture, syntheticToken, response, task } from "./sdk-seams-fixture-20261012.ts";

const TASK = task().id, OTHER = "00000000-0000-4000-8000-0000000000ff";
const FINISHED = "That task is finished. Send a new message without task_id to start a new task.";
const errorInfo = (reason: string, domain = "a2a-protocol.org") => [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain }];
function fixture() {
  const p = profile(), server = new WireFixture();
  p.files.write("config.json", config);
  p.files.write("tokens.json", { access: syntheticToken, expires: Date.now() + 3600_000, resource: config.origin, issuer: config.issuer, clientId: config.oauthClientId });
  const input = (value: unknown) => { const path = join(p.base, "input.json"); writeFileSync(path, JSON.stringify(value)); return path; };
  async function cli(args: string[], post?: (body: { id: unknown; method: string }) => Response | Promise<Response>, other?: (url: URL, init?: RequestInit) => Response | undefined) {
    const lines: string[] = []; let posts = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      const u = new URL(String(url));
      const custom = other?.(u, init); if (custom) return custom;
      if (init?.method === "POST" && post && !u.pathname.includes("network-1")) { posts++; return post(JSON.parse(String(init.body))); }
      return server.fetch(url, init);
    };
    const code = await main([args[0], "--profile", p.root, ...args.slice(1), "--json"], undefined, line => lines.push(line), { fetchImpl });
    return { code, out: JSON.parse(lines[0]), posts };
  }
  const ledger = () => p.files.read<Ledger>("ledger.json")!;
  return { ...p, server, input, cli, ledger };
}
const rpcError = (error: object, id?: unknown) => (body: { id: unknown }) => response({ jsonrpc: "2.0", id: id === undefined ? body.id : id, error });

test("a complete JSON-RPC error is a definite refusal with its code and reason, recorded as refused", async t => {
  const f = fixture(); t.after(f.cleanup);
  const r = await f.cli(["send", "--recipient", "other/sender", "--input", f.input({ parts: [{ text: "x" }] })], rpcError({ code: -32602, message: "Invalid parameters", data: [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }, ...errorInfo("INVALID_PARAMS")] }));
  assert.equal(r.code, 1); assert.equal(r.posts, 1);
  assert.deepEqual([r.out.error, r.out.uncertain, r.out.rpcCode, r.out.reason], ["SEND_REFUSED", false, -32602, "INVALID_PARAMS"]);
  assert.match(r.out.recovery, /Nothing was delivered/);
  assert.equal(f.ledger().outgoing[r.out.messageId].phase, "refused");
  assert.equal(JSON.stringify(r.out).includes("Invalid parameters"), false, "server text is not echoed");
});

test("a send that continues a finished task says so, from the reason or from what the client knows", async t => {
  const f = fixture(); t.after(f.cleanup);
  const send = () => ["send", "--recipient", "other/sender", "--input", f.input({ parts: [{ text: "more" }], taskId: TASK })];
  // Server with the TASK_TERMINAL ErrorInfo reason (A2A v1.0 §3.1.1 UnsupportedOperationError).
  let r = await f.cli(send(), rpcError({ code: -32004, message: "Task is already in a terminal state", data: errorInfo("TASK_TERMINAL", "concourse.krishnan.ca") }));
  assert.deepEqual([r.out.error, r.out.uncertain, r.out.rpcCode, r.out.reason, r.out.recovery, r.out.taskId], ["TASK_ALREADY_FINISHED", false, -32004, "TASK_TERMINAL", FINISHED, TASK]);
  // Current server: a bare UNSUPPORTED_OPERATION; a read shows the task is terminal.
  f.server.current = { ...task(), status: { state: "TASK_STATE_COMPLETED" } };
  r = await f.cli(send(), rpcError({ code: -32004, message: "Unsupported operation", data: errorInfo("UNSUPPORTED_OPERATION") }));
  assert.deepEqual([r.out.error, r.out.uncertain, r.out.reason, r.out.recovery], ["TASK_ALREADY_FINISHED", false, "UNSUPPORTED_OPERATION", FINISHED]);
  // Not known to be terminal: still a definite refusal, with both likely causes.
  f.server.current = task("TASK_STATE_WORKING");
  r = await f.cli(send(), rpcError({ code: -32004, message: "Unsupported operation" }));
  assert.deepEqual([r.out.error, r.out.uncertain, r.out.rpcCode], ["SEND_REFUSED", false, -32004]);
  assert.match(r.out.recovery, /without task_id.*use reply/);
  assert.ok(Object.values(f.ledger().outgoing).every(o => o.phase === "refused"));
});

test("anything short of a complete error response for our request stays uncertain", async t => {
  const f = fixture(); t.after(f.cleanup);
  const bodies: ((body: { id: unknown }) => Response)[] = [
    rpcError({ code: -32001, message: "Task not found" }, "some-other-request"),
    body => response({ id: body.id, error: { code: -32001, message: "Task not found" } }),
    rpcError({ code: "-32001", message: "Task not found" }),
    rpcError({ code: -32001 }),
    body => response({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "x" }, result: {} }),
    () => new Response("not JSON", { status: 200, headers: { "content-type": "application/json" } }),
    () => response({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" } }, 503),
    () => new Response("upstream down", { status: 502 }),
    () => { throw new Error("connection reset after write"); },
  ];
  for (const post of bodies) {
    const r = await f.cli(["send", "--recipient", "other/sender", "--input", f.input({ parts: [{ text: "x" }] })], post);
    assert.equal(r.posts, 1); assert.equal(r.out.uncertain, true, JSON.stringify(r.out));
    assert.match(r.out.error, /^SEND_UNCONFIRMED_OR_REFUSED messageId=/);
  }
  assert.ok(Object.values(f.ledger().outgoing).every(o => o.phase === "uncertain"));
});

test("cancel and reply refusals are definite; reply to a finished task says so", async t => {
  const f = fixture(); t.after(f.cleanup);
  let r = await f.cli(["cancel", "--recipient", "other/sender", "--task-id", TASK], rpcError({ code: -32002, message: "Task not cancelable", data: errorInfo("TASK_NOT_CANCELABLE") }));
  assert.deepEqual([r.out.error, r.out.uncertain, r.out.rpcCode, r.out.reason], ["CANCEL_REFUSED", false, -32002, "TASK_NOT_CANCELABLE"]);
  const reply = () => ["reply", "--task-id", TASK, "--input", f.input({ state: "TASK_STATE_COMPLETED" })];
  const refuse = (status: number) => (u: URL, init?: RequestInit) => init?.method === "PATCH" ? response({ error: "invalid_transition" }, status) : undefined;
  f.server.current = { ...task(), status: { state: "TASK_STATE_COMPLETED" } };
  r = await f.cli(reply(), undefined, refuse(422));
  assert.deepEqual([r.out.error, r.out.uncertain, r.out.status, r.out.recovery], ["TASK_ALREADY_FINISHED", false, 422, FINISHED]);
  f.server.current = task("TASK_STATE_WORKING");
  r = await f.cli(reply(), undefined, refuse(404));
  assert.deepEqual([r.out.error, r.out.uncertain, r.out.status], ["REPLY_REFUSED", false, 404]);
  assert.ok(Object.values(f.ledger().replies!).every(x => x.phase === "refused"));
});

test("HTTP refusals name their status; shortened task IDs are refused before any request", async t => {
  const f = fixture(); t.after(f.cleanup);
  let r = await f.cli(["task", "--task-id", OTHER], undefined, u => u.pathname === `/api/tasks/${OTHER}` ? response({}, 404) : undefined);
  assert.deepEqual([r.out.error, r.out.uncertain], ["HTTP_REFUSED_404", false]);
  const calls = f.server.calls.length;
  for (const args of [["task", "--task-id", "00000000"], ["reply", "--task-id", "0000-1", "--input", f.input({ state: "TASK_STATE_COMPLETED" })], ["send", "--recipient", "other/sender", "--input", f.input({ parts: [{ text: "x" }], taskId: "00000000" })]]) {
    r = await f.cli(args);
    assert.deepEqual([r.out.error, r.out.uncertain], ["FULL_TASK_ID_REQUIRED", false]); assert.match(r.out.recovery, /full ID/);
  }
  assert.equal(f.server.calls.length, calls);
});

test("rpcRefusal keeps only the numeric code and a well-formed ErrorInfo reason", () => {
  const body = (error: object) => ({ id: 7, body: { jsonrpc: "2.0", id: 7, error } });
  assert.deepEqual(rpcRefusal(body({ code: -32001, message: "m", data: errorInfo("TASK_NOT_FOUND") }), "X")!.details, { rpcCode: -32001, reason: "TASK_NOT_FOUND" });
  assert.deepEqual(rpcRefusal(body({ code: -32001, message: "m", data: errorInfo("not a reason\u001b") }), "X")!.details, { rpcCode: -32001 });
  assert.deepEqual(rpcRefusal(body({ code: -32001, message: "m", data: [{ reason: "NO_TYPE" }] }), "X")!.details, { rpcCode: -32001 });
  assert.equal(rpcRefusal(undefined, "X"), undefined);
  assert.equal(rpcRefusal({ id: undefined, body: { jsonrpc: "2.0", error: { code: 1, message: "m" } } }, "X"), undefined);
});

// Shapes copied from the server's A2a::Error#to_h and A2a::RelayError.
test("only pre-commit codes are refusals; errors after a saved write stay uncertain", () => {
  const body = (error: object) => ({ id: 7, body: { jsonrpc: "2.0", id: 7, error } });
  const terminal = { code: -32004, message: "Task is already in a terminal state; send a new message without a task ID to start a new task", data: [...errorInfo("UNSUPPORTED_OPERATION"), ...errorInfo("TASK_TERMINAL", "concourse.krishnan.ca")] };
  assert.deepEqual(rpcRefusal(body(terminal), "X")!.details, { rpcCode: -32004, reason: "TASK_TERMINAL" });
  const waitLimit = { code: -32603, message: "Internal error", data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RELAY_WAIT_LIMIT", domain: "concourse.example.com", metadata: { taskId: "123e4567-e89b-42d3-a456-426614174000" } }] };
  assert.equal(rpcRefusal(body(waitLimit), "X"), undefined);
  assert.equal(rpcRefusal(body({ code: -32603, message: "Internal error" }), "X"), undefined);
  assert.equal(rpcRefusal(body({ code: -32050, message: "custom" }), "X"), undefined);
  assert.equal(rpcRefusal(body({ code: -32001, message: "m", data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "X", domain: "d", metadata: { deliveryId: "d1" } }] }), "X"), undefined);
});

test("an absent receipt proves non-delivery only after the original request could have landed", async () => {
  const journal = new Memory(); let now = 1_000_000, sends = 0;
  let receipt: Json = { operation: "delivery", state: "absent", accepted: false };
  const client = { send: async (): Promise<Json> => { sends++; throw new SafeError("TIMEOUT", true); }, get: async () => task(), network: async () => receipt };
  const outbox = new Outbox(journal, client, () => {}, () => now);
  await assert.rejects(outbox.send("owner/peer", [{ text: "x" }]), /SEND_UNCONFIRMED_OR_REFUSED/);
  const id = Object.keys(journal.value.outgoing)[0];
  now += RECEIPT_SETTLE_MS - 1;
  await assert.rejects(outbox.reconcile(id), (e: unknown) => e instanceof SafeError && e.code === "SEND_RECEIPT_UNRESOLVED" && e.uncertain && /Check again in two minutes/.test(e.message));
  assert.equal(journal.value.outgoing[id].phase, "uncertain");
  // Other non-acceptance states never prove non-delivery.
  receipt = { operation: "delivery", state: "uncertain", accepted: false, taskStatus: null };
  now += 1;
  await assert.rejects(outbox.reconcile(id), (e: unknown) => e instanceof SafeError && e.code === "SEND_RECEIPT_UNRESOLVED" && e.uncertain);
  receipt = { operation: "delivery", state: "absent", accepted: false };
  await assert.rejects(outbox.reconcile(id), (e: unknown) => e instanceof SafeError && e.code === "NOT_DELIVERED" && !e.uncertain && /safe to send it again as a new message/.test(e.message));
  assert.equal(journal.value.outgoing[id].phase, "refused"); assert.equal(sends, 1);
  await assert.rejects(outbox.reconcile(id), /NO_UNCERTAIN_SEND/);
  // An intent written before preparedAt existed starts its window at the first absent answer.
  journal.value.outgoing.legacy = { messageId: "legacy", recipient: "owner/peer", phase: "uncertain", expectReply: true };
  await assert.rejects(outbox.reconcile("legacy"), /SEND_RECEIPT_UNRESOLVED/);
  assert.equal(journal.value.outgoing.legacy.absentAt, now);
  now += RECEIPT_SETTLE_MS;
  await assert.rejects(outbox.reconcile("legacy"), /NOT_DELIVERED/);
});

test("CLI reconcile-send reports NOT_DELIVERED as a definite answer", async t => {
  const f = fixture(); t.after(f.cleanup);
  f.server.rpcFailure = "lost";
  await f.cli(["send", "--recipient", "other/sender", "--input", f.input({ parts: [{ text: "x" }] })]);
  f.server.rpcFailure = undefined;
  const l = f.ledger(), id = Object.keys(l.outgoing)[0];
  l.outgoing[id].preparedAt = Date.now() - RECEIPT_SETTLE_MS - 1; f.files.write("ledger.json", l);
  const network = (u: URL, init?: RequestInit) => {
    if (init?.method !== "POST" || !u.pathname.includes("network-1")) return;
    const body = JSON.parse(String(init.body));
    return response({ jsonrpc: "2.0", id: body.id, result: { message: { messageId: "receipt1", role: "ROLE_AGENT", parts: [{ data: { operation: "delivery", state: "absent", accepted: false } }] } } });
  };
  const r = await f.cli(["reconcile-send", "--message-id", id], undefined, network);
  assert.deepEqual([r.code, r.out.phase, r.out.error, r.out.uncertain, r.out.messageId], [1, "blocked", "NOT_DELIVERED", false, id]);
  assert.match(r.out.recovery, /not delivered.*safe to send it again as a new message/);
  assert.equal(f.ledger().outgoing[id].phase, "refused");
});
