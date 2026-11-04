import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "../src/client.ts";
import { Outbox } from "../src/outgoing.ts";
import { SafeError, type Fetch } from "../src/http.ts";
import { answer, config, deferred, identity, Memory, response } from "./helpers.ts";

function fixture() {
  const journal = new Memory(), reads: string[] = [];
  let oversized = true, identityOversized = false, refusal = 0;
  const transport: Fetch = async (input, init) => {
    assert.equal(init?.method, "GET", "no write or replacement send is permitted");
    const path = new URL(String(input)).pathname;
    if (path === "/api/identity") return response({ ...identity, ...(identityOversized ? { padding: "x".repeat(1024 * 1024) } : {}) });
    const id = decodeURIComponent(path.slice("/api/tasks/".length));
    reads.push(id);
    if (refusal) return response({ privateError: "x".repeat(1024 * 1024) }, refusal);
    const value = { ...answer(`answer-${id}`), id, ...(id === "a-large" && oversized ? { history: [{ messageId: "huge", role: "ROLE_USER", parts: [{ text: "private-large-" + "x".repeat(1024 * 1024) }] }] } : {}) };
    return response(value);
  };
  for (const taskId of ["a-large", "b-valid"]) {
    const messageId = `send-${taskId}`;
    journal.value.outgoing[messageId] = { messageId, taskId, recipient: "owner/peer", phase: "accepted", resultType: "task", expectReply: true, parts: [{ text: `original-${taskId}` }] };
  }
  const client = new Client(config, async () => "synthetic-not-a-credential", transport);
  return { journal, reads, client, outbox: new Outbox(journal, client), smaller: () => { oversized = false; }, badIdentity: () => { identityOversized = true; }, refuse: (status: number) => { refusal = status; } };
}

test("actual Client oversized Task advances a bounded durable answer sweep and never starves later requested output", async () => {
  const f = fixture(), original = structuredClone(f.journal.value.outgoing["send-a-large"]);
  await f.outbox.sweep(1);
  assert.deepEqual(f.reads, ["a-large"]);
  assert.equal(f.journal.value.cursors.answers, "a-large");
  assert.deepEqual(f.journal.value.blockedAnswers, { "a-large": { code: "RESPONSE_TOO_LARGE" } });
  assert.deepEqual(f.journal.value.outgoing["send-a-large"], original, "a failed content read cannot alter accepted intent or invent terminal state");
  assert.equal(f.outbox.offers().length, 0);
  await new Outbox(f.journal, f.client).sweep(1);
  assert.deepEqual(f.reads, ["a-large", "b-valid"]);
  assert.equal(f.journal.value.cursors.answers, undefined);
  assert.equal(f.outbox.offers().length, 1);
  assert.ok(f.outbox.take("send-b-valid"));
  await f.outbox.sweep(1);
  assert.deepEqual(f.reads, ["a-large", "b-valid", "a-large"]);
  assert.equal(f.outbox.offers().length, 0);
  f.smaller();
  await f.outbox.sweep(1);
  assert.equal(f.journal.value.blockedAnswers?.["a-large"], undefined);
  assert.equal(f.outbox.offers().length, 1, "later bounded output remains recoverable without resending");
  assert.ok(f.outbox.take("send-a-large"));
});

test("oversized identity is fatal authentication uncertainty rather than per-Task content quarantine", async () => {
  const f = fixture(); f.badIdentity();
  await assert.rejects(f.outbox.sweep(), (e: unknown) => e instanceof SafeError && e.code === "V3_IDENTITY_REFUSED");
  assert.deepEqual(f.reads, []);
  assert.equal(f.journal.value.blockedAnswers, undefined);
  assert.equal(f.journal.value.cursors.answers, undefined);
});

test("HTTP 401 and 503 remain fatal even when their unneeded error bodies exceed the content cap", async () => {
  for (const status of [401, 503]) {
    const f = fixture(); f.refuse(status);
    await assert.rejects(f.outbox.sweep(), (e: unknown) => e instanceof SafeError && e.code === `HTTP_REFUSED_${status}` && e.status === status);
    assert.deepEqual(f.reads, ["a-large"]);
    assert.equal(f.journal.value.blockedAnswers, undefined);
    assert.equal(f.journal.value.cursors.answers, undefined);
    assert.equal(f.outbox.offers().length, 0);
  }
});

test("content-diagnostic persistence failure is not swallowed or allowed to advance the durable cursor", async () => {
  const f = fixture(); f.journal.fail = true;
  await assert.rejects(f.outbox.sweep(), /synthetic disk failure/);
  assert.deepEqual(f.reads, ["a-large"]);
  assert.equal(f.journal.value.blockedAnswers, undefined);
  assert.equal(f.journal.value.cursors.answers, undefined);
});

test("late oversized read cannot overwrite a newer valid output observation with a stale diagnostic", async () => {
  const f = fixture(), entered = deferred<void>(), finish = deferred<void>();
  let reads = 0;
  f.client.get = async id => {
    if (reads++ === 0) { entered.resolve(); await finish.promise; throw new SafeError("RESPONSE_TOO_LARGE"); }
    return { ...answer("new-question", "TASK_STATE_INPUT_REQUIRED"), id };
  };
  const earlier = f.outbox.sweep(1); await entered.promise;
  await new Outbox(f.journal, f.client).sweep(1);
  finish.resolve(); await earlier;
  assert.equal(f.journal.value.blockedAnswers?.["a-large"], undefined);
  assert.equal(f.outbox.offers().length, 1);
  assert.equal(f.journal.value.outgoing["send-a-large"].observedTerminal, undefined);
});

test("lost lifecycle ownership after a content failure cannot publish diagnostics or advance the cursor", async () => {
  const f = fixture(), entered = deferred<void>(), finish = deferred<void>();
  let alive = true;
  f.client.get = async () => { entered.resolve(); await finish.promise; throw new SafeError("RESPONSE_TOO_LARGE"); };
  const guarded = new Outbox(f.journal, f.client, () => { if (!alive) throw new SafeError("SESSION_REPLACED"); });
  const sweep = guarded.sweep(1); await entered.promise;
  alive = false; const writes = f.journal.writes; finish.resolve();
  await assert.rejects(sweep, (e: unknown) => e instanceof SafeError && e.code === "SESSION_REPLACED");
  assert.equal(f.journal.writes, writes);
  assert.equal(f.journal.value.blockedAnswers, undefined);
  assert.equal(f.journal.value.cursors.answers, undefined);
});
