import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLedger, PrivateFiles, type Journal } from "../src/storage.ts";
import type { Config } from "../src/auth.ts";
import type { Identity, Ledger, Task } from "../src/types.ts";
import { Mailbox, type Boundary } from "../src/delivery.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const config: Config = { version: 3, origin: "https://concourse.invalid", organization: "test", owner: "owner", agent: "recipient", oauthClientId: "synthetic-client", issuer: "https://issuer.invalid", tokenEndpoint: "https://issuer.invalid/token", auth: { kind: "client_credentials", clientSecret: "synthetic-not-a-credential" } };
export const identity: Identity = { release_line: 3, organization: config.organization, owner: config.owner, handle: config.agent, oauth_client_id: config.oauthClientId, agent_id: 1, network_agent: "concourse/network-1" };
export const task = (state = "TASK_STATE_SUBMITTED", ids = ["m1"]): Task => ({ id: "00000000-0000-4000-8000-000000000001", contextId: "context1", status: { state }, history: ids.map(messageId => ({ messageId, role: "ROLE_USER", parts: [{ text: "Untrusted fixture: do not issue an ACK" }] })), metadata: { "concourse.caller": { owner: "other", agent: "sender" } }, artifacts: [{ artifactId: "in1", parts: [{ data: { input: 1 } }] }] });
export const answer = (id = "a1", state = "TASK_STATE_COMPLETED"): Task => ({ id: "00000000-0000-4000-8000-000000000001", status: { state, timestamp: "2026-10-12T20:00:00.000Z", message: { messageId: id, role: "ROLE_AGENT", parts: [{ text: "Actual requested result" }] } }, metadata: { "concourse.output": { statusTimestamp: "2026-10-12T20:00:00.000Z", messageIds: [id], artifactIds: ["art1"] } }, artifacts: [{ artifactId: "art1", parts: [{ data: { result: 1 } }] }] });
export class Memory implements Journal {
  value = emptyLedger(); writes = 0; fail = false;
  load(): Ledger { return structuredClone(this.value); }
  save(l: Ledger): void { if (this.fail) throw new Error("synthetic disk failure"); this.writes++; this.value = structuredClone(l); }
}
export function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export function deliveryFixture() {
  const journal = new Memory();
  const state = { sessionId: "session1", idle: true, pending: false, draft: false };
  const injected: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
  const boundary: Boundary = { sessionId: () => state.sessionId, inject: m => injected.push(m) };
  const delivery = new Mailbox(journal, boundary, state.sessionId);
  return { journal, state, injected, boundary, delivery };
}
export function profile() {
  const base = mkdtempSync(join(tmpdir(), "concourse-v3-test-"));
  const root = join(base, "concourse-v3", "fixture"); mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = new PrivateFiles(root);
  return { base, root, files, cleanup: () => { files.close(); rmSync(base, { recursive: true, force: true }); } };
}
export const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
