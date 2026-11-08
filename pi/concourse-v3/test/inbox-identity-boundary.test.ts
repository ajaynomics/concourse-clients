import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Runtime } from "../src/runtime.ts";
import { SafeError, type Fetch } from "../src/http.ts";
import { answer, config, profile } from "./helpers.ts";
import { outboundGuard, syntheticToken } from "./sdk-seams-fixture-20261012.ts";

test("identity read failures stop refresh before tail, answer polling or cached-answer hand-off", async () => {
  for (const failure of ["transport", "oversized", 401, 403, 404, 429, 500, 503] as const) {
    const p = profile(); let identityReads = 0, otherReads = 0, sweeps = 0, handoffs = 0;
    p.files.write("tokens.json", { access: syntheticToken, expires: Date.now() + 3600_000, resource: config.origin, issuer: config.issuer, clientId: config.oauthClientId });
    const fetchImpl: Fetch = async url => {
      if (new URL(String(url)).pathname === "/api/identity") {
        identityReads++;
        if (failure === "transport") throw new Error("synthetic identity timeout");
        return new Response(failure === "oversized" ? "x".repeat(1024 * 1024 + 1) : "{}", { status: typeof failure === "number" ? failure : 200, headers: { "content-type": "application/json" } });
      }
      otherReads++; throw new Error("No I/O may follow failed identity");
    };
    const guard = outboundGuard();
    const ctx = { sessionManager: { getSessionId: () => "synthetic-session" }, ui: { setStatus: () => {}, notify: () => {} } } as unknown as ExtensionContext;
    const pi = { sendMessage: () => { handoffs++; } } as unknown as ExtensionAPI;
    const runtime = new Runtime({ handOff: m => pi.sendMessage(m), fetchImpl, current: () => true, labelled: () => false }, ctx, p.files, config, "test");
    try {
      const l = runtime.journal.load(); l.cursors.inbox = "saved-tail";
      l.outgoing.cached = { messageId: "cached", recipient: "other/sender", taskId: "00000000-0000-4000-8000-000000000001", phase: "accepted", expectReply: true, observedTerminal: true, answer: JSON.parse(JSON.stringify(answer("cached-result"))), answerKey: "cached-key" };
      runtime.journal.save(l);
      runtime.outbox.sweep = async () => { sweeps++; };
      await assert.rejects(runtime.refresh(), SafeError);
      assert.equal(identityReads, 1, `${failure}: no tail after failed identity`);
      assert.equal(otherReads, 0); assert.equal(sweeps, 0); assert.equal(handoffs, 0);
      assert.equal(runtime.journal.load().outgoing.cached.delivered, undefined);
      assert.equal(runtime.journal.load().cursors.inbox, "saved-tail");
    } finally { await runtime.stop(); guard.close(); p.cleanup(); }
  }
});
