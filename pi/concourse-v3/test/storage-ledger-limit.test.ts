import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Mailbox } from "../src/delivery.ts";
import { createProfile, FileJournal, PrivateFiles } from "../src/storage.ts";
import type { Ledger } from "../src/types.ts";

const legacyLimit = 4 * 1024 * 1024;
const ledgerLimit = 16 * 1024 * 1024;

function profile(t: import("node:test").TestContext): string {
  const parent = mkdtempSync(join(tmpdir(), "ledger-limit-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "concourse-v3", "fixture");
  createProfile(root);
  return root;
}

function ledgerOfSize(size: number): Ledger {
  const ledger: Ledger = {
    version: 3,
    batches: {
      delivered: { id: "delivered", taskId: "task", sessionId: "session", messageIds: ["old-go"], caller: null, phase: "handed-off" },
      queued: { id: "queued", taskId: "task", sessionId: "session", messageIds: ["pending"], messages: [{ messageId: "pending", role: "ROLE_USER", parts: [{ text: "keep" }] }], caller: null, phase: "queued" }
    },
    outgoing: {
      sent: { messageId: "sent", recipient: "fixture/peer", taskId: "task", expectReply: true, phase: "accepted" },
      pending: { messageId: "pending-send", recipient: "fixture/peer", expectReply: true, phase: "uncertain", parts: [{ text: "" }] }
    },
    replies: {
      reply: { id: "reply", taskId: "task", outcome: { state: "TASK_STATE_COMPLETED" }, phase: "accepted" },
      uncertain: { id: "uncertain", taskId: "task", outcome: { state: "TASK_STATE_WORKING", parts: [{ text: "keep" }] }, phase: "uncertain" }
    },
    cursors: { inbox: "cursor" },
    seenAnswers: { answer: true }
  };
  ledger.outgoing.pending.parts![0].text = "x".repeat(size - Buffer.byteLength(JSON.stringify(ledger)));
  return ledger;
}

test("journal saves and reopens 16 MiB without losing pending mail or receipts", t => {
  const root = profile(t);
  const path = join(root, "ledger.json");
  const files = new PrivateFiles(root);
  const atLimit = ledgerOfSize(ledgerLimit);
  try {
    const journal = new FileJournal(files);
    const old = ledgerOfSize(legacyLimit);
    journal.save(old);
    assert.deepEqual(journal.load(), old);
    journal.save(atLimit);
    assert.equal(statSync(path).size, ledgerLimit);
  } finally { files.close(); }

  const reopened = new PrivateFiles(root);
  try {
    const journal = new FileJournal(reopened);
    assert.deepEqual(journal.load(), atLimit);
    assert.throws(() => journal.save(ledgerOfSize(ledgerLimit + 1)), /Private ledger full/);
    assert.equal(statSync(path).size, ledgerLimit);
    assert.deepEqual(journal.load(), atLimit);
  } finally { reopened.close(); }
});

test("a ledger already over 16 MiB fails closed, and other files stay at 4 MiB", t => {
  const root = profile(t);
  const files = new PrivateFiles(root);
  try {
    files.write("other.json", "x".repeat(legacyLimit - 2));
    assert.throws(() => files.write("other.json", "x".repeat(legacyLimit - 1)), /Private ledger full/);
    truncateSync(join(root, "other.json"), legacyLimit + 1);
    assert.throws(() => files.read("other.json"), /Unsafe private file/);

    const path = join(root, "ledger.json");
    writeFileSync(path, "{}", { mode: 0o600 });
    truncateSync(path, ledgerLimit + 1);
    assert.throws(() => new FileJournal(files).load(), /Unsafe private file/);
    assert.equal(statSync(path).size, ledgerLimit + 1);
  } finally { files.close(); }
});

test("recovery above 4 MiB hands off pending and fresh mail, not a retained message ID", t => {
  const root = profile(t);
  const original = new PrivateFiles(root);
  try { new FileJournal(original).save(ledgerOfSize(legacyLimit + 1)); } finally { original.close(); }

  const reopened = new PrivateFiles(root);
  try {
    const journal = new FileJournal(reopened);
    const delivered: string[][] = [];
    const mailbox = new Mailbox(journal, { sessionId: () => "session", inject: message => delivered.push((message.details as { messageIds: string[] }).messageIds) }, "session");
    mailbox.recover();
    const task = {
      id: "task", status: { state: "TASK_STATE_WORKING" },
      history: ["old-go", "pending", "fresh"].map(messageId => ({ messageId, role: "ROLE_USER", parts: [{ text: "fixture" }] }))
    };
    assert.deepEqual(mailbox.enqueue(task)?.messageIds, ["fresh"]);
    mailbox.flush();
    assert.deepEqual(delivered, [["pending"], ["fresh"]]);
    assert.equal(mailbox.enqueue(task), undefined);
  } finally { reopened.close(); }
});
