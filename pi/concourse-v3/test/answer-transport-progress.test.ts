import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "../src/client.ts";
import { Outbox } from "../src/outgoing.ts";
import { SafeError, type Fetch } from "../src/http.ts";
import { answer, config, identity, Memory, response } from "./helpers.ts";

function fixture() {
  const journal = new Memory(), reads: string[] = [];
  let failTask = true, failIdentity: "transport" | number | undefined;
  const transport: Fetch = async (input, init) => {
    assert.equal(init?.method, "GET", "read recovery never sends or replays a write");
    const path = new URL(String(input)).pathname;
    if (path === "/api/identity") {
      if (failIdentity === "transport") throw new Error("synthetic identity timeout");
      return response(identity, failIdentity ?? 200);
    }
    const id = decodeURIComponent(path.slice("/api/tasks/".length)); reads.push(id);
    if (id === "a-timeout" && failTask) throw new Error("synthetic task timeout");
    return response({ ...answer(`answer-${id}`), id });
  };
  for (const taskId of ["a-timeout", "b-completed"]) {
    const messageId = `send-${taskId}`;
    journal.value.outgoing[messageId] = { messageId, taskId, recipient: "owner/peer", phase: "accepted", resultType: "task", expectReply: true, parts: [{ text: "original request" }] };
  }
  const client = new Client(config, async () => "synthetic-not-a-credential", transport);
  return { journal, reads, client, outbox: new Outbox(journal, client), recover: () => { failTask = false; }, identityFailure: (failure: "transport" | number) => { failIdentity = failure; } };
}

test("task timeout stays visible but cannot pin subsequent answer sweeps", async () => {
  const f = fixture(), original = structuredClone(f.journal.value.outgoing["send-a-timeout"]);
  await assert.rejects(f.outbox.sweep(), (e: unknown) => e instanceof SafeError && e.code === "TRANSPORT_FAILED");
  assert.deepEqual(f.reads, ["a-timeout"]);
  assert.equal(f.journal.value.cursors.answers, "a-timeout");
  assert.equal(f.journal.value.blockedAnswers?.["a-timeout"].code, "TRANSPORT_FAILED");
  assert.deepEqual(f.journal.value.outgoing["send-a-timeout"], original);
  await new Outbox(f.journal, f.client).sweep();
  assert.deepEqual(f.reads, ["a-timeout", "b-completed"]);
  assert.ok(f.outbox.take("send-b-completed"));
  f.recover(); await f.outbox.sweep();
  assert.equal(f.journal.value.blockedAnswers?.["a-timeout"], undefined);
  assert.ok(f.outbox.take("send-a-timeout"));
  await f.outbox.sweep(); assert.equal(f.outbox.offers().length, 0);
});

test("identity failures are fatal, not task-local timeouts or HTTP refusals", async () => {
  for (const failure of ["transport", 401, 403, 404, 429, 500, 503] as const) {
    const f = fixture(); f.identityFailure(failure);
    await assert.rejects(f.outbox.sweep(), SafeError);
    assert.deepEqual(f.reads, []);
    assert.equal(f.journal.value.cursors.answers, undefined);
    assert.equal(f.journal.value.blockedAnswers, undefined);
    assert.equal(f.outbox.offers().length, 0);
  }
});

test("a task timeout cannot advance a cursor after generation ownership changes", async () => {
  const f = fixture(); let checks = 0;
  const guarded = new Outbox(f.journal, f.client, () => { if (++checks === 2) throw new SafeError("SESSION_REPLACED"); });
  await assert.rejects(guarded.sweep(), (e: unknown) => e instanceof SafeError && e.code === "SESSION_REPLACED");
  assert.equal(f.journal.value.cursors.answers, undefined);
  assert.equal(f.journal.value.blockedAnswers, undefined);
});
