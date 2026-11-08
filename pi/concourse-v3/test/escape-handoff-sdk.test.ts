import assert from "node:assert/strict";
import test from "node:test";
import { nativeFixture, bounded, toolCall, type ScriptResult } from "./sdk-native-fixture-20261012.ts";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { answer, deferred, task } from "./helpers.ts";
import { DUPLICATE_NOTICE, Handoffs } from "../src/handoff.ts";

type Fixture = Awaited<ReturnType<typeof nativeFixture>>;
const mailText = (id: string) => `Peer mail ${id} exact`;
const mail = (id: string) => { const t = task("TASK_STATE_SUBMITTED", [id]); t.history![0].parts = [{ text: mailText(id) }]; return t; };
const count = (value: unknown, text: string) => JSON.stringify(value).split(text).length - 1;

// Each listed model call waits until the test releases it or Pi aborts it.
async function gated(gatedCalls: number[], options: { first?: (context: TranscriptContext, index: number) => ScriptResult | undefined } = {}) {
  const entered = new Map<number, ReturnType<typeof deferred<void>>>(), release = new Map<number, ReturnType<typeof deferred<void>>>();
  for (const i of gatedCalls) { entered.set(i, deferred<void>()); release.set(i, deferred<void>()); }
  const f = await nativeFixture((context, index) => {
    const early = options.first?.(context, index); if (early) return early;
    entered.get(index)?.resolve();
    return { text: `Synthetic reply ${index}`, gate: release.get(index) };
  }, { inboxEmpty: true });
  const notes: string[] = [];
  const runner = f.session.extensionRunner;
  runner.setUIContext({ ...runner.getUIContext(), notify: (text: string) => { notes.push(text); } }, "print");
  return { f, notes, entered: (i: number) => bounded(entered.get(i)!.promise), release: (i: number) => release.get(i)!.resolve() };
}

// Mirrors interactive Escape: restoreQueuedMessagesToEditor clears every queue, then aborts.
async function escape(f: Fixture, run: Promise<void>) {
  f.session.clearQueue(); await f.session.abort(); await bounded(run); await bounded(f.session.waitForIdle());
}
const held = (f: Fixture) => f.session.sessionManager.getBranch().filter(e => e.type === "custom_message" && (e.details as { held?: boolean } | undefined)?.held);

test("mail queued mid-turn survives Escape, starts no turn, and joins the next prompt once", { timeout: 10000 }, async t => {
  const { f, notes, entered } = await gated([0]); t.after(() => f.cleanup());
  const run = f.session.prompt("Long human work");
  await entered(0);
  f.server.inbox = [mail("escape-1")];
  await f.session.prompt("/concourse-v3 refresh");
  assert.equal(Object.values(f.journal.load().batches)[0].phase, "handed-off");
  await escape(f, run);
  assert.equal(f.contexts.length, 1, "Escape starts no turn by itself");
  assert.equal(held(f).length, 1, "the mail is back in the conversation");
  assert.deepEqual(notes, ["Concourse mail held after Escape: 1 message(s), included with your next message"]);
  await bounded(f.session.prompt("Next human message")); await bounded(f.session.waitForIdle());
  assert.equal(f.contexts.length, 2);
  assert.equal(count(f.contexts[1], mailText("escape-1")), 1, "the next prompt carries the mail exactly once");
  assert.match(JSON.stringify(f.contexts[1]), /Next human message/);
  assert.equal(Object.values(f.journal.load().batches)[0].messages, undefined, "content is still not written to the ledger");
  assert.deepEqual(f.errors, []);
});

test("mail consumed by a normal turn is not put back", { timeout: 10000 }, async t => {
  const { f, notes, entered, release } = await gated([0]); t.after(() => f.cleanup());
  const run = f.session.prompt("Long human work");
  await entered(0);
  f.server.inbox = [mail("normal-1")];
  await f.session.prompt("/concourse-v3 refresh");
  release(0); await bounded(run); await bounded(f.session.waitForIdle());
  assert.equal(f.contexts.length, 2, "Pi's follow-up delivered the mail in its own turn");
  assert.equal(held(f).length, 0); assert.deepEqual(notes, []);
  await bounded(f.session.prompt("Next human message")); await bounded(f.session.waitForIdle());
  assert.equal(count(f.contexts.at(-1), mailText("normal-1")), 1);
  assert.deepEqual(f.errors, []);
});

test("a requested answer offered mid-turn survives Escape once", { timeout: 10000 }, async t => {
  // Calls 0-1 send the request; call 2 is the long turn interrupted by Escape.
  const { f, notes, entered } = await gated([2], { first: (_c, index) => index === 0 ? { calls: [toolCall("concourse_v3_send", { to: "other/sender", parts: [{ text: "Need a result" }] })] } : undefined });
  t.after(() => f.cleanup());
  await bounded(f.session.prompt("Send a request")); await bounded(f.session.waitForIdle());
  assert.equal(f.contexts.length, 2);
  const run = f.session.prompt("Long human work");
  await entered(2);
  f.server.current = answer("requested-answer");
  await f.session.prompt("/concourse-v3 refresh");
  assert.equal(Object.values(f.journal.load().outgoing)[0].delivered, true, "the answer was handed to Pi");
  await escape(f, run);
  assert.equal(f.contexts.length, 3, "Escape starts no turn by itself");
  assert.equal(held(f).length, 1); assert.equal(notes.length, 1);
  await f.session.prompt("/concourse-v3 refresh"); await bounded(f.session.waitForIdle());
  assert.equal(held(f).length, 1, "a later sweep does not offer it again");
  await bounded(f.session.prompt("Next human message")); await bounded(f.session.waitForIdle());
  assert.equal(count(f.contexts.at(-1), "Actual requested result"), 1);
  assert.deepEqual(f.errors, []);
});

test("two Escapes never duplicate mail", { timeout: 10000 }, async t => {
  const { f, notes, entered } = await gated([0, 1]); t.after(() => f.cleanup());
  let run = f.session.prompt("First long work");
  await entered(0);
  f.server.inbox = [mail("twice-1")];
  await f.session.prompt("/concourse-v3 refresh");
  await escape(f, run);
  run = f.session.prompt("Second long work");
  await entered(1);
  assert.equal(count(f.contexts[1], mailText("twice-1")), 1);
  f.server.inbox = [mail("twice-1"), mail("twice-2")];
  await f.session.prompt("/concourse-v3 refresh");
  await escape(f, run);
  assert.equal(f.contexts.length, 2, "neither Escape starts a turn");
  assert.equal(held(f).length, 2, "each mail is put back once");
  assert.equal(notes.length, 2);
  await bounded(f.session.prompt("Final human message")); await bounded(f.session.waitForIdle());
  assert.equal(f.contexts.length, 3);
  assert.equal(count(f.contexts[2], mailText("twice-1")), 1);
  assert.equal(count(f.contexts[2], mailText("twice-2")), 1);
  assert.deepEqual(f.errors, []);
});

test("an abort that keeps Pi's queue does not duplicate the mail it put back", { timeout: 10000 }, async t => {
  const { f, entered } = await gated([0]); t.after(() => f.cleanup());
  const run = f.session.prompt("Long human work");
  await entered(0);
  f.server.inbox = [mail("kept-1")];
  await f.session.prompt("/concourse-v3 refresh");
  // SDK/RPC abort and /compact leave the queued original in place.
  await f.session.abort(); await bounded(run); await bounded(f.session.waitForIdle());
  assert.equal(held(f).length, 1);
  await bounded(f.session.prompt("Next human message")); await bounded(f.session.waitForIdle());
  assert.equal(count(f.contexts.at(-1), mailText("kept-1")), 1, "the late original is replaced, not repeated");
  assert.match(JSON.stringify(f.contexts.at(-1)), new RegExp(DUPLICATE_NOTICE.replace(/[()]/g, "\\$&")));
  assert.deepEqual(f.errors, []);
});

test("hand-off ordering: mail that waited in Pi's queue is put back; idle-sent mail runs on its own", () => {
  const sent: { message: { customType: string; content: string; details: object }; options: object }[] = [], notes: string[] = [];
  const pi = { sendMessage: (message: never, options: object) => { sent.push({ message, options }); } } as unknown as ConstructorParameters<typeof Handoffs>[0];
  const ctx = { ui: { notify: (text: string) => { notes.push(text); } } } as unknown as Parameters<Handoffs["settled"]>[1];
  const h = new Handoffs(pi, ["concourse-v3.delivery"]);
  const message = (id: string) => ({ customType: "concourse-v3.delivery", display: true, content: id, details: { id } });
  const back = () => sent.filter(s => (s.message.details as { held?: boolean }).held).map(s => s.message.content);
  h.started();
  h.send(message("consumed"), true); h.send(message("dropped"), true);
  assert.equal(h.consumed({ role: "custom", ...message("consumed") }), undefined, "Pi drained it in the run");
  // After agent_end Pi can still be mid-run (retry backoff, compaction, settle hooks): still queued.
  h.send(message("after-end"), true);
  // Sent while Pi emits agent_settled: idle, so Pi defers it to a run of its own.
  h.send(message("late"), false);
  h.settled(true, ctx);
  assert.deepEqual(back(), ["dropped", "after-end"]);
  assert.ok(sent.filter(s => (s.message.details as { held?: boolean }).held).every(s => JSON.stringify(s.options) === JSON.stringify({ triggerTurn: false })));
  assert.equal(notes.length, 1);
  h.settled(true, ctx); assert.equal(back().length, 2, "a second settle puts nothing back again");
  h.started();
  assert.equal(h.consumed({ role: "custom", ...message("late") }), undefined, "the late hand-off is consumed by its own run");
  const held = sent.find(s => s.message.content === "dropped" && (s.message.details as { held?: boolean }).held)!;
  assert.equal(h.consumed({ role: "custom", ...held.message }), undefined, "the held copy never matches its original");
  assert.equal(h.consumed({ role: "custom", ...message("dropped") })?.content, DUPLICATE_NOTICE, "a surviving original is replaced once");
  assert.equal(h.consumed({ role: "custom", ...message("dropped") }), undefined);
  h.settled(false, ctx); assert.equal(back().length, 2);
  // Idle-sent mail deferred by prompt preparation that lands in that prompt's run queue.
  h.send(message("deferred"), false); h.started(); h.settled(true, ctx);
  assert.deepEqual(back(), ["dropped", "after-end", "deferred"]);
});
