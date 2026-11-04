import { test } from "node:test";
import assert from "node:assert/strict";
import { Outbox } from "../src/outgoing.ts";
import { SafeError } from "../src/http.ts";
import { answer, deferred, Memory, task } from "./helpers.ts";
import type { Json, Task } from "../src/types.ts";

const stamp = "2026-10-12T20:00:00.000Z";
function output(t: Task, messageIds: string[], artifactIds: string[]): Task {
  return { ...t, status: { ...t.status, timestamp: stamp }, metadata: { ...t.metadata, "concourse.output": { statusTimestamp: stamp, messageIds, artifactIds } } };
}

// Managed-worker claim recovery is superseded; normal-queue recovery lives in delivery.test.ts.

test("unavailable middle Task cannot starve later answers or lose intent across restart", async () => {
  const journal = new Memory(), reads: string[] = [];
  for (const id of ["a", "b", "c"]) journal.value.outgoing[id] = { messageId: id, recipient: "owner/peer", taskId: id, phase: "accepted", expectReply: true };
  const client = {
    send: async () => task() as unknown as Json,
    network: async () => ({}),
    get: async (id: string) => { reads.push(id); if (id === "b") throw new SafeError("HTTP_REFUSED", false, 404); return id === "c" ? output({ ...answer(), id }, ["a1"], ["art1"]) : { ...task("TASK_STATE_WORKING"), id }; },
  };
  await new Outbox(journal, client).sweep(2);
  assert.deepEqual(reads, ["a", "b"]); assert.equal(journal.value.cursors.answers, "b");
  const restarted = new Outbox(journal, client); await restarted.sweep(2);
  assert.deepEqual(reads, ["a", "b", "c"]); assert.equal(restarted.offers().length, 1);
  assert.equal(journal.value.outgoing.b.phase, "accepted"); assert.equal(journal.value.outgoing.b.observedTerminal, undefined);
  restarted.take("c"); await restarted.sweep(3); assert.equal(restarted.offers().length, 0);
});

test("state-only completion with retained progress stays quiet even when intermediate poll was missed", async () => {
  for (const pollProgress of [false, true]) {
    const journal = new Memory(); let value = task();
    const client = { send: async () => value as unknown as Json, get: async () => value, network: async () => ({}) };
    const outbox = new Outbox(journal, client); await outbox.send("owner/peer", [{ text: "request" }]);
    const progress = output(answer("progress", "TASK_STATE_WORKING"), ["progress"], ["art1"]);
    if (pollProgress) { value = progress; await outbox.sweep(); }
    value = output({ ...progress, status: { ...progress.status, state: "TASK_STATE_COMPLETED" } }, [], []);
    await outbox.sweep(); assert.equal(outbox.offers().length, 0);
  }
  const journal = new Memory(); let value = task();
  const client = { send: async () => value as unknown as Json, get: async () => value, network: async () => ({}) };
  const outbox = new Outbox(journal, client); await outbox.send("owner/peer", [{ text: "request" }]);
  value = output(answer("fresh"), ["fresh"], []); await outbox.sweep(); assert.equal(outbox.offers().length, 1);
});

test("direct-Message receipt establishes acceptance without body, fake Task, resend or answer", async () => {
  const journal = new Memory(); let sends = 0, reads = 0;
  const client = {
    send: async (): Promise<Json> => { sends++; throw new SafeError("TIMEOUT", true); },
    get: async () => { reads++; return task(); },
    network: async () => ({ accepted: true, state: "delivered", resultType: "message", taskStatus: null }),
  };
  const outbox = new Outbox(journal, client);
  await assert.rejects(outbox.send("owner/peer", [{ data: { operation: "presence" } }]), /SEND_UNCONFIRMED/);
  const original = Object.values(journal.value.outgoing)[0];
  await outbox.reconcile(original.messageId); await outbox.sweep();
  const saved = journal.value.outgoing[original.messageId];
  assert.equal(saved.phase, "accepted"); assert.equal(saved.taskId, undefined);
  assert.equal(saved.directResultUnavailable, true); assert.equal(outbox.offers().length, 0);
  assert.deepEqual(saved.parts, original.parts); assert.equal(sends, 1); assert.equal(reads, 0);
});


test("output observation is fail-closed and accepts newly authored artifact-only wire parts", async () => {
  const journal = new Memory(); let value = task();
  const client = { send: async () => value as unknown as Json, get: async () => value, network: async () => ({}) };
  const outbox = new Outbox(journal, client); await outbox.send("owner/peer", [{ text: "request" }]);
  const v = answer();
  for (const metadata of [undefined, { "concourse.output": { statusTimestamp: "wrong", messageIds: ["a1"], artifactIds: ["art1"] } }]) {
    value = { ...v, metadata };
    // Do not terminalize these malformed observations in the fixture: each stands for a separate polling intent.
    for (const o of Object.values(journal.value.outgoing)) o.observedTerminal = false;
    await outbox.sweep(); assert.equal(outbox.offers().length, 0);
  }
  for (const o of Object.values(journal.value.outgoing)) o.observedTerminal = false;
  value = output({ ...v, status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: "new-file", parts: [{ url: "https://artifact.invalid/file" }] }] }, [], ["new-file"]);
  await outbox.sweep(); assert.equal(outbox.offers().length, 1);
});

test("a reconciled Message continuation preserves original correlation without declaring its Task terminal", async () => {
  const journal = new Memory(); let reads = 0;
  const client = {
    send: async (): Promise<Json> => { throw new SafeError("TIMEOUT", true); },
    get: async () => { reads++; return task(); },
    network: async () => ({ accepted: true, state: "delivered", resultType: "message", taskStatus: null }),
  };
  const outbox = new Outbox(journal, client);
  await assert.rejects(outbox.send("owner/peer", [{ text: "continuation" }], true, "original-task", "original-context"));
  const id = Object.keys(journal.value.outgoing)[0]; await outbox.reconcile(id); await outbox.sweep();
  const saved = journal.value.outgoing[id];
  assert.equal(saved.taskId, "original-task"); assert.equal(saved.contextId, "original-context");
  assert.equal(saved.resultType, "message"); assert.equal(saved.observedTerminal, undefined);
  assert.equal(reads, 0); assert.equal(outbox.offers().length, 0);
});

test("accepted continuation retires every pending old question without take or model turn", async () => {
  const journal = new Memory(); let value = task();
  const client = { send: async () => value as unknown as Json, get: async () => value, network: async () => ({ accepted: true, taskId: "00000000-0000-4000-8000-000000000001" }) };
  const outbox = new Outbox(journal, client);
  await outbox.send("owner/peer", [{ text: "request" }]); await outbox.send("owner/peer", [{ text: "more context" }], false, "00000000-0000-4000-8000-000000000001");
  value = answer("old-question", "TASK_STATE_INPUT_REQUIRED"); await outbox.sweep();
  const old = outbox.offers()[0];
  const other = Object.values(journal.value.outgoing).find(o => o.messageId !== old.messageId)!;
  other.answer = old.answer; other.answerKey = old.answerKey;
  value = output(value, [], []); // Real server retains Q in status but knows later caller input exists.
  await outbox.send("owner/peer", [{ text: "answer to Q" }], false, "00000000-0000-4000-8000-000000000001");
  assert.equal(outbox.offers().length, 0); assert.equal(outbox.take(old.messageId), undefined);
  assert.equal(journal.value.outgoing[old.messageId].delivered, false);
  const restarted = new Outbox(journal, client); assert.equal(restarted.offers().length, 0);
  value = { ...value, status: { ...value.status, state: "TASK_STATE_WORKING" } }; await restarted.sweep();
  assert.equal(restarted.offers().length, 0);
  value = { ...value, status: { ...value.status, state: "TASK_STATE_COMPLETED" } }; await restarted.sweep();
  assert.equal(restarted.offers().length, 0);
});

test("a later server observation retires a question answered outside this outbox", async () => {
  for (const state of ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"]) {
    const journal = new Memory(); let value = task();
    const client = { send: async () => value as unknown as Json, get: async () => value, network: async () => ({}) };
    const outbox = new Outbox(journal, client); await outbox.send("owner/peer", [{ text: "request" }]);
    value = answer("old-question", "TASK_STATE_INPUT_REQUIRED"); await outbox.sweep(); assert.equal(outbox.offers().length, 1);
    value = output({ ...value, status: { ...value.status, state } }, [], []); await outbox.sweep();
    assert.equal(outbox.offers().length, 0);
  }
});

test("uncertain continuation keeps question until proven accepted and cannot suppress a newer question", async () => {
  for (const newer of [false, true]) {
    const journal = new Memory(); let value = task(), fail = false;
    const client = { send: async (): Promise<Json> => { if (fail) throw new SafeError("TIMEOUT", true); return value as unknown as Json; }, get: async () => value, network: async () => ({ accepted: true, taskId: "00000000-0000-4000-8000-000000000001" }) };
    const outbox = new Outbox(journal, client); await outbox.send("owner/peer", [{ text: "request" }]);
    value = answer("old-question", "TASK_STATE_INPUT_REQUIRED"); await outbox.sweep();
    fail = true; await assert.rejects(outbox.send("owner/peer", [{ text: "answer" }], false, "00000000-0000-4000-8000-000000000001"));
    const unknown = Object.values(journal.value.outgoing).find(o => o.phase === "uncertain")!;
    assert.equal(outbox.offers().length, 1);
    if (newer) { value = answer("new-question", "TASK_STATE_INPUT_REQUIRED"); await outbox.sweep(); }
    await outbox.reconcile(unknown.messageId);
    assert.equal(outbox.offers().length, newer ? 1 : 0);
    if (newer) assert.equal((outbox.offers()[0].answer as unknown as Task).status.message?.messageId, "new-question");
  }
});

test("an immediately authored new question after accepted input remains offerable", async () => {
  const journal = new Memory(); let value = task();
  const client = { send: async () => value as unknown as Json, get: async () => value, network: async () => ({}) };
  const outbox = new Outbox(journal, client); await outbox.send("owner/peer", [{ text: "request" }]);
  value = answer("old-question", "TASK_STATE_INPUT_REQUIRED"); await outbox.sweep();
  const old = outbox.offers()[0];
  value = answer("genuinely-new-question", "TASK_STATE_INPUT_REQUIRED");
  await outbox.send("owner/peer", [{ text: "answer old question" }], false, "00000000-0000-4000-8000-000000000001");
  assert.equal(outbox.take(old.messageId), undefined); assert.equal(outbox.offers().length, 1);
  assert.equal((outbox.offers()[0].answer as unknown as Task).status.message?.messageId, "genuinely-new-question");
  assert.equal(journal.value.seenAnswers[old.answerKey!], undefined);
  assert.equal(journal.value.retiredQuestions?.[old.answerKey!], true);
});

test("a delayed pre-input question read cannot resurrect Q after known continuation acceptance", async () => {
  const journal = new Memory(); let value = task();
  const gate = deferred<Task>(), entered = deferred<void>();
  const client = { send: async () => value as unknown as Json, get: async () => { entered.resolve(); return gate.promise; }, network: async () => ({}) };
  const outbox = new Outbox(journal, client); await outbox.send("owner/peer", [{ text: "request" }]);
  const old = answer("old-question", "TASK_STATE_INPUT_REQUIRED");
  const sweep = outbox.sweep(); await entered.promise;
  value = output(old, [], []);
  await outbox.send("owner/peer", [{ text: "answer learned through get" }], false, "00000000-0000-4000-8000-000000000001");
  gate.resolve(old); await sweep;
  assert.equal(outbox.offers().length, 0);
  assert.equal(Object.values(journal.value.outgoing).filter(o => o.phase === "accepted").length, 2);
});

test("a delayed send snapshot cannot resurrect Q after a later accepted input", async () => {
  const journal = new Memory(), gate = deferred<Json>(), entered = deferred<void>();
  const old = answer("old-question", "TASK_STATE_INPUT_REQUIRED");
  const client = {
    send: async (_to: string, _id: string, parts: Record<string, Json>[]): Promise<Json> => {
      if (parts[0].text === "delayed") { entered.resolve(); return gate.promise; }
      return output(old, [], []) as unknown as Json;
    },
    get: async () => task(), network: async () => ({}),
  };
  const outbox = new Outbox(journal, client);
  const first = outbox.send("owner/peer", [{ text: "delayed" }], true, "00000000-0000-4000-8000-000000000001"); await entered.promise;
  await outbox.send("owner/peer", [{ text: "answer from get" }], false, "00000000-0000-4000-8000-000000000001");
  gate.resolve(old as unknown as Json); await first;
  assert.equal(outbox.offers().length, 0);
});

test("a delayed old send response cannot permanently retire a newer question observed by sweep", async () => {
  const journal = new Memory(); let value = task(), delayed = false;
  const gate = deferred<Json>(), entered = deferred<void>();
  const client = { send: async (): Promise<Json> => { if (delayed) { entered.resolve(); return gate.promise; } return value as unknown as Json; }, get: async () => value, network: async () => ({}) };
  const outbox = new Outbox(journal, client); await outbox.send("owner/peer", [{ text: "request" }]);
  value = answer("Q1", "TASK_STATE_INPUT_REQUIRED"); await outbox.sweep();
  const old = outbox.offers()[0];
  delayed = true; const send = outbox.send("owner/peer", [{ text: "answer Q1" }], false, "00000000-0000-4000-8000-000000000001"); await entered.promise;
  const response = output(value, [], []);
  value = answer("Q2", "TASK_STATE_INPUT_REQUIRED"); await outbox.sweep();
  const fresh = outbox.offers()[0]; assert.equal((fresh.answer as unknown as Task).status.message?.messageId, "Q2");
  gate.resolve(response as unknown as Json); await send;
  assert.equal(journal.value.retiredQuestions?.[old.answerKey!], true);
  assert.equal(outbox.offers().length, 1); assert.equal(journal.value.retiredQuestions?.[fresh.answerKey!], undefined);
  assert.ok(new Outbox(journal, client).offers().some(o => o.answerKey === fresh.answerKey));
});

test("a fenced overlapping snapshot defers a real new question to a fresh sweep rather than losing it", async () => {
  const journal = new Memory(); let value = task(), reads = 0;
  const gate = deferred<Task>(), entered = deferred<void>();
  const client = { send: async () => value as unknown as Json, get: async () => { if (++reads === 1) { entered.resolve(); return gate.promise; } return value; }, network: async () => ({}) };
  const outbox = new Outbox(journal, client); await outbox.send("owner/peer", [{ text: "request" }]);
  const sweep = outbox.sweep(); await entered.promise;
  value = output(answer("Q1", "TASK_STATE_INPUT_REQUIRED"), [], []);
  await outbox.send("owner/peer", [{ text: "input" }], false, "00000000-0000-4000-8000-000000000001");
  value = answer("Q2", "TASK_STATE_INPUT_REQUIRED"); gate.resolve(value); await sweep;
  assert.equal(outbox.offers().length, 0); await outbox.sweep();
  assert.equal(outbox.offers().length, 1); assert.equal((outbox.offers()[0].answer as unknown as Task).status.message?.messageId, "Q2");
});
