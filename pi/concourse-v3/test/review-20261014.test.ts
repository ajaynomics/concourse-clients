import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "../src/client.ts";
import { doorbell } from "../src/doorbell.ts";
import { Outbox } from "../src/outgoing.ts";
import { Replies } from "../src/replies.ts";
import { attention, statusLine } from "../src/status.ts";
import { SafeError, type Fetch } from "../src/http.ts";
import type { Batch, Json, Task } from "../src/types.ts";
import { answer, config, deliveryFixture, identity, Memory, response, task } from "./helpers.ts";

const status = (code: number) => new SafeError("HTTP_REFUSED", false, code);

test("send: a malformed recipient or part is refused before any intent is journaled", async () => {
  const journal = new Memory(); let sends = 0;
  const outbox = new Outbox(journal, { send: async () => { sends++; return task() as unknown as Json; }, get: async () => task(), network: async () => ({}) });
  await assert.rejects(outbox.send("https://service.example/a2a/team/owner/x", [{ text: "hi" }]), (e: unknown) => e instanceof SafeError && !e.uncertain && /QUALIFIED_RECIPIENT_REQUIRED/.test(e.message));
  await assert.rejects(outbox.send("owner/peer", [{ file: "x" }]), (e: unknown) => e instanceof SafeError && !e.uncertain && /UNSUPPORTED_OUTBOUND_PART/.test(e.message));
  assert.deepEqual(journal.value.outgoing, {}); assert.equal(sends, 0);
});

test("send: a definite HTTP 4xx is recorded as refused; other failures stay uncertain", async () => {
  for (const [failure, phase, uncertain] of [[status(404), "refused", false], [new SafeError("SESSION_REPLACED"), "uncertain", true], [status(502), "uncertain", true]] as const) {
    const journal = new Memory();
    const outbox = new Outbox(journal, { send: async () => { throw failure; }, get: async () => task(), network: async () => ({}) });
    await assert.rejects(outbox.send("owner/peer", [{ text: "hi" }]), (e: unknown) => e instanceof SafeError && e.uncertain === uncertain);
    assert.equal(Object.values(journal.value.outgoing)[0].phase, phase);
  }
});

test("sweep: one Task's persistent server error does not starve later answers; auth stays fatal", async () => {
  const journal = new Memory(), reads: string[] = []; let fail = 500;
  for (const taskId of ["a-broken", "b-fine"]) journal.value.outgoing[`send-${taskId}`] = { messageId: `send-${taskId}`, taskId, recipient: "owner/peer", phase: "accepted", resultType: "task", expectReply: true };
  const outbox = new Outbox(journal, { send: async () => ({}), network: async () => ({}), get: async (id: string): Promise<Task> => { reads.push(id); if (id === "a-broken") throw status(fail); return { ...answer(), id }; } });
  await outbox.sweep(); await outbox.sweep();
  assert.deepEqual(journal.value.blockedAnswers, { "a-broken": { code: "HTTP_500" } });
  assert.equal(outbox.offers().length, 1); assert.equal(outbox.offers()[0].taskId, "b-fine");
  assert.deepEqual(reads, ["a-broken", "b-fine", "a-broken"], "the cursor advances past the failing Task");
  for (fail of [401, 403, 429, 503]) await assert.rejects(new Outbox(journal, { send: async () => ({}), network: async () => ({}), get: async () => { throw status(fail); } }).sweep(), /HTTP_REFUSED/);
});

test("take: the delivered answer body is dropped while its dedupe fence remains", async () => {
  const journal = new Memory();
  const outbox = new Outbox(journal, { send: async () => task() as unknown as Json, get: async () => answer(), network: async () => ({}) });
  const sent = await outbox.send("owner/peer", [{ text: "q" }]); await outbox.sweep();
  assert.ok(outbox.take(sent.messageId));
  const o = journal.value.outgoing[sent.messageId];
  assert.equal(o.answer, undefined); assert.equal(o.delivered, true); assert.equal(journal.value.seenAnswers[o.answerKey!], true);
  assert.equal(outbox.take(sent.messageId), undefined); await outbox.sweep(); assert.equal(outbox.offers().length, 0);
});

test("mailbox: hand-off keeps IDs only, recovery prunes legacy content and keeps legacy final phases", () => {
  const f = deliveryFixture(), journal = f.journal, injected = f.injected;
  const legacy = { id: "old", taskId: "t0", sessionId: "session1", messageIds: ["m0"], messages: [{ messageId: "m0", role: "ROLE_USER", parts: [{ text: "old" }] }], caller: null, phase: "settled" } as unknown as Batch;
  journal.value.batches.old = legacy;
  journal.value.batches.gone = { ...structuredClone(legacy), id: "gone", messageIds: ["mg"], phase: "handed-off" };
  const mailbox = f.delivery;
  mailbox.recover();
  assert.equal(journal.value.batches.old.phase as string, "settled");
  assert.equal(journal.value.batches.gone.messages, undefined);
  mailbox.enqueue(task()); mailbox.flush();
  const fresh = Object.values(journal.value.batches).find(b => b.taskId === "task1")!;
  assert.equal(injected.length, 1); assert.equal(fresh.phase, "handed-off"); assert.equal(fresh.messages, undefined); assert.ok(fresh.messageIds.length);
});

test("reply: invalid outcomes are refused before journaling; a 4xx is a definite refusal", async () => {
  const journal = new Memory(); let calls = 0, failure: unknown = status(422);
  const replies = new Replies(journal, { reply: async () => { calls++; throw failure; } });
  await assert.rejects(replies.send("t1", { state: "TASK_STATE_INPUT_REQUIRED" }), /QUESTION_CONTENT_REQUIRED/);
  await assert.rejects(replies.send("t1", { state: "TASK_STATE_CANCELED" }), /INVALID_REPLY_STATE/);
  assert.equal(journal.value.replies, undefined); assert.equal(calls, 0);
  await assert.rejects(replies.send("t1", { state: "TASK_STATE_COMPLETED", parts: [{ text: "x" }] }), (e: unknown) => e instanceof SafeError && !e.uncertain && /REPLY_REFUSED/.test(e.message));
  failure = new SafeError("HTTP_TRANSPORT_FAILED", true);
  await assert.rejects(replies.send("t1", { state: "TASK_STATE_COMPLETED", parts: [{ text: "x" }] }), (e: unknown) => e instanceof SafeError && e.uncertain);
  assert.deepEqual(Object.values(journal.value.replies!).map(r => r.phase), ["refused", "uncertain"]);
});

test("doorbell: callbacks are not awaited, so a slow refresh cannot stall the SSE read loop", async () => {
  const encoder = new TextEncoder(), controller = new AbortController(); let hints = 0;
  const ready = `event: ready\ndata: ${JSON.stringify({ release_line: 3, sessionId: "session1", connectionId: "11111111-2222-4333-8444-555555555555" })}\n\n`;
  const fetchImpl: Fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(ready + "event: ping\ndata: {}\n\n".repeat(3))); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  // Callback types are synchronous: a slow refresh behind them must be fire-and-forget.
  await doorbell({ config, sessionId: "session1", token: "synthetic", signal: controller.signal, fetchImpl, ready: () => {}, hint: () => { hints++; } }).catch(() => {});
  assert.equal(hints, 3);
});

test("client: Client.send uses the same recipient validation and makes no request for a URL", async () => {
  let requests = 0; const client = new Client(config, async () => "synthetic", async () => { requests++; return response(identity); });
  await assert.rejects(client.send("https://x.invalid/a2a/o/a", "m1", [{ text: "x" }]), /QUALIFIED_RECIPIENT_REQUIRED/);
  assert.equal(requests, 0);
});

test("footer: names agent and host, shows push/polling, last check, mail and attention; failures keep last ok", () => {
  const l = new Memory().value, at = new Date(2026, 9, 14, 9, 5).getTime();
  l.batches.b = { id: "b", taskId: "t", sessionId: "s1", messageIds: ["m"], caller: null, phase: "handed-off" };
  l.outgoing.o = { messageId: "o", recipient: "owner/peer", expectReply: true, phase: "uncertain" };
  l.blockedAnswers = { t2: { code: "HTTP_500" } };
  const a = attention(l, "s1"), base = { handle: "owner/reviewer", host: "service.example", live: true, failures: 0 };
  assert.equal(statusLine({ ...base, checkedAt: at }, a), "Concourse ✓ owner/reviewer @ service.example · ⚡ push · checked 09:05 · mail 1 · 1 unconfirmed: /concourse-v3 status · 1 blocked");
  assert.equal(statusLine({ ...base, live: false }, { mail: 0, unconfirmed: 0, blocked: 0 }), "Concourse ✓ owner/reviewer @ service.example · starting");
  assert.equal(statusLine({ ...base, live: false, failures: 2, error: "HTTP_REFUSED", lastOkAt: at }, { mail: 0, unconfirmed: 0, blocked: 0 }), "Concourse ⚠ owner/reviewer @ service.example 2 failed checks (HTTP_REFUSED) · last ok 09:05");
});
