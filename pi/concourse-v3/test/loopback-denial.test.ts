import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { getEventListeners } from "node:events";
import { Loopback } from "../src/loopback.ts";
import { SafeError } from "../src/http.ts";

const issuer = "https://app.krishnan.ca", state = "s".repeat(43);
const denial = { error: "access_denied", state, iss: issuer };
function callback(port: number, query: string, options: { method?: string; path?: string; host?: string | string[] } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = Array.isArray(options.host) ? options.host.flatMap(host => ["Host", host]) : { Host: options.host ?? `127.0.0.1:${port}` };
    const req = request({ hostname: "127.0.0.1", port, path: `${options.path ?? "/callback"}?${query}`, method: options.method ?? "GET", headers }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.once("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.once("error", reject); req.end();
  });
}

for (const details of [false, true]) test(`issuer/state-bound denial (${details ? "provider details" : "bare error"}) settles promptly, consumes pending timer/listener, never calls complete or exposes provider text`, { timeout: 2000 }, async t => {
  const listener = new Loopback(), controller = new AbortController(); await listener.bind();
  let complete = 0;
  const timers = t.mock.method(globalThis, "setTimeout"), clears = t.mock.method(globalThis, "clearTimeout");
  try {
    const wait = listener.wait("/callback", state, 300_000, controller.signal, async () => { complete++; }, issuer);
    const timer = timers.mock.calls[0].result;
    const rejected = assert.rejects(wait, (e: unknown) => e instanceof SafeError && e.code === "AUTHORIZATION_DENIED" && e.message === "AUTHORIZATION_DENIED" && !e.uncertain);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    const params: Record<string, string> = { ...denial };
    if (details) { params.error_description = "provider-private-reason"; params.error_uri = "https://issuer.invalid/private-reason"; }
    const response = await callback(listener.port, new URLSearchParams(params).toString());
    await rejected;
    assert.deepEqual(response, { status: 200, body: "Return to the Concourse terminal." });
    assert.ok(clears.mock.calls.some(call => call.arguments[0] === timer), "the pending five-minute timer was cleared");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0); assert.equal(complete, 0);
    assert.equal((await callback(listener.port, new URLSearchParams(denial).toString())).status, 400, "consumed callback cannot complete twice");
    // Slot can be reused immediately; no timeout or hidden code exchange is pending.
    const setup = listener.wait("/setup-complete", state, 1000);
    assert.equal((await callback(listener.port, new URLSearchParams({ state, organization: "team" }).toString(), { path: "/setup-complete" })).status, 200);
    assert.equal((await setup).get("organization"), "team");
  } finally { await listener.close(); t.mock.restoreAll(); }
});

test("forged/malformed/mixed/duplicate denial variants leave the exact success wait intact", { timeout: 5000 }, async () => {
  const listener = new Loopback(); await listener.bind(); let complete = 0, settled = false;
  const wait = listener.wait("/callback", state, 4000, undefined, async () => { complete++; }, issuer);
  void wait.then(() => { settled = true; }, () => { settled = true; });
  try {
    const q = (values: Record<string, string>) => new URLSearchParams(values).toString(), valid = q(denial);
    const invalid = [
      q({ ...denial, state: "wrong" }), q({ ...denial, iss: "https://wrong.invalid" }),
      q({ error: "access_denied", state }), q({ error: "access_denied", iss: issuer }),
      q({ ...denial, error: "" }), q({ ...denial, error: "   " }), q({ ...denial, error: "x".repeat(257) }), q({ ...denial, error: "bad\ntext" }),
      q({ ...denial, error_description: "x".repeat(2049) }), q({ ...denial, error_uri: "x".repeat(2049) }), q({ ...denial, error_description: "terminal\u001b[2J" }),
      q({ ...denial, code: "cannot-also-exchange" }), q({ ...denial, arbitrary: "forbidden" }),
      ...["error", "state", "iss", "error_description", "error_uri"].map(key => `${valid}&${key}=first&${key}=second`),
      // Success variant must not accept error-only extras without the error key.
      q({ code: "valid-code", state, iss: issuer, error_description: "forbidden" }),
    ];
    for (const query of invalid) {
      assert.equal((await callback(listener.port, query)).status, 400);
      assert.equal(settled, false); assert.equal(complete, 0);
    }
    for (const options of [{ method: "POST" }, { host: "attacker.invalid" }, { host: `localhost:${listener.port}` }, { host: [`127.0.0.1:${listener.port}`, `127.0.0.1:${listener.port}`] }, { path: "/elsewhere" }, { path: "/callback/" }]) {
      assert.equal((await callback(listener.port, valid, options)).status, 400); assert.equal(settled, false);
    }
    const success = await callback(listener.port, q({ code: "valid-code", state, iss: issuer }));
    assert.equal(success.status, 200); assert.equal((await wait).get("code"), "valid-code"); assert.equal(complete, 1);
  } finally { await listener.close(); await wait.catch(() => {}); }
});

test("setup-complete stays a strict separate shape and cannot consume OAuth error fields", async () => {
  const listener = new Loopback(); await listener.bind();
  const wait = listener.wait("/setup-complete", state, 1000);
  try {
    const valid = new URLSearchParams({ state, organization: "team" }).toString();
    for (const extra of ["error=access_denied", "iss=" + encodeURIComponent(issuer), "code=forged"]) assert.equal((await callback(listener.port, `${valid}&${extra}`, { path: "/setup-complete" })).status, 400);
    assert.equal((await callback(listener.port, valid, { path: "/setup-complete" })).status, 200); await wait;
  } finally { await listener.close(); await wait.catch(() => {}); }
});

test("the sign-in window is fifteen minutes; longer listener waits stay refused", async () => {
  const listener = new Loopback(); await listener.bind();
  try {
    assert.throws(() => listener.wait("/callback", state, 15 * 60_000 + 1), /INVALID_CALLBACK_WAIT/);
    const wait = listener.wait("/callback", state, 15 * 60_000); void wait.catch(() => {});
  } finally { await listener.close(); }
});
