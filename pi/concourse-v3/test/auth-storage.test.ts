import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { TokenClient, validateConfig, type Config } from "../src/auth.ts";
import { Lifetime } from "../src/lifetime.ts";
import { PrivateFiles } from "../src/storage.ts";
import { config, deferred, profile, response } from "./helpers.ts";

const oauth = (): Config => ({ ...config, authorizationEndpoint: "https://issuer.invalid/authorize", auth: { kind: "oauth", redirectUri: "http://127.0.0.1:4555/callback" } });
const token = { access_token: "synthetic.token", token_type: "Bearer", expires_in: 3600, scope: "concourse" };
test("machine-first token has exact resource/scope/client binding, no automatic issuance or refresh", async () => {
  const p = profile(); let calls = 0;
  try {
    const client = new TokenClient(config, p.files, async (url, init) => {
      calls++; assert.equal(String(url), config.tokenEndpoint); assert.equal(init?.redirect, "error");
      const form = new URLSearchParams(String(init?.body)); assert.equal(form.get("resource"), config.origin); assert.equal(form.get("scope"), "concourse"); assert.equal(form.get("grant_type"), "client_credentials");
      assert.match(String(new Headers(init?.headers).get("authorization")), /^Basic /); return response(token);
    });
    const values = await Promise.all([client.token(), client.token()]); assert.deepEqual(values, [token.access_token, token.access_token]); assert.equal(calls, 1);
    assert.equal(await client.token(), token.access_token); assert.equal(calls, 1);
    p.files.write("tokens.json", { access: "synthetic", expires: Date.now() + 90000, resource: "https://wrong.invalid", clientId: config.oauthClientId, issuer: config.issuer });
    await assert.rejects(client.token(), /TOKEN_BINDING_MISMATCH/);
  } finally { p.cleanup(); }
});
test("config refuses insecure origin, wrong issuer token origin, excess identity and client bindings", () => {
  for (const c of [{ ...config, origin: "https://concourse.invalid/path" }, { ...config, origin: "http://concourse.invalid" }, { ...config, tokenEndpoint: "https://other.invalid/token" }, { ...config, agent: "../other" }, { ...config, oauthClientId: "" }]) assert.throws(() => validateConfig(c));
});
test("OAuth PKCE/state/resource/issuer and fifteen-minute intent expiry; no listeners", async () => {
  const p = profile(); let now = 1_000, exchanges = 0;
  try {
    const client = new TokenClient(oauth(), p.files, async (_url, init) => {
      exchanges++; const form = new URLSearchParams(String(init?.body)); assert.equal(form.get("grant_type"), "authorization_code"); assert.equal(form.get("code_verifier")?.length, 43); assert.equal(form.get("resource"), config.origin);
      return response({ ...token, refresh_token: "synthetic.refresh" });
    }, () => now);
    const url = new URL(client.authorizationUrl()); assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.get("scope"), "concourse"); assert.equal(url.searchParams.get("code_challenge")?.length, 43);
    const state = url.searchParams.get("state")!;
    await assert.rejects(client.completeAuthorization({ code: "fixture", state: "wrong", iss: config.issuer }), /CALLBACK_REFUSED/);
    await assert.rejects(client.completeAuthorization({ code: "fixture", state, iss: "https://wrong.invalid" }), /CALLBACK_REFUSED/);
    assert.equal(p.files.read<{ expires: number }>("oauth-pending.json")!.expires, 1_000 + 15 * 60_000);
    now = 901_001; await assert.rejects(client.completeAuthorization({ code: "fixture", state, iss: config.issuer }), /CALLBACK_REFUSED/);
    now = 1000; await client.completeAuthorization({ code: "fixture", state, iss: config.issuer }); assert.equal(exchanges, 1);
    await assert.rejects(client.completeAuthorization({ code: "fixture", state, iss: config.issuer }), /CALLBACK_REFUSED/);
  } finally { p.cleanup(); }
});
test("rotating refresh timeout/invalid response is durably uncertain and never retried", async () => {
  const p = profile(); let calls = 0;
  try {
    p.files.write("tokens.json", { access: "old", refresh: "rotating", expires: 1, resource: config.origin, clientId: config.oauthClientId, issuer: config.issuer });
    const client = new TokenClient(oauth(), p.files, async () => { calls++; throw new Error("synthetic timeout"); });
    await assert.rejects(client.token(), /TRANSPORT_FAILED/); assert.equal(p.files.read("oauth-exchange.json"), true);
    await assert.rejects(client.token(), /OAUTH_EXCHANGE_UNCERTAIN/); assert.equal(calls, 1);
    assert.throws(() => client.authorizationUrl(), /OAUTH_EXCHANGE_UNCERTAIN/);
  } finally { p.cleanup(); }
});
test("stale generation cannot save a late token/callback; ownership stays locked while draining", async () => {
  const p = profile(), life = new Lifetime(() => true), gate = deferred<Response>(), entered = deferred<void>();
  const release = p.files.acquire();
  try {
    const client = new TokenClient(config, p.files, async () => { entered.resolve(); return gate.promise; }, Date.now, life.check);
    const operation = life.run(() => client.token()); await entered.promise; life.invalidate();
    let drained = false; const draining = life.drain().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    const other = new PrivateFiles(p.root); assert.throws(() => other.acquire(), /already owned/); other.close();
    gate.resolve(response(token)); await assert.rejects(operation, /SESSION_REPLACED/); await draining;
    assert.equal(p.files.read("tokens.json"), undefined); release(); const second = p.files.acquire(); second();
  } finally { release(); p.cleanup(); }
});
test("private files are opened-FD checked, bounded, owned, atomic and refuse symlink/hardlink/mode", () => {
  const p = profile();
  try {
    p.files.write("safe.json", { value: 1 }); assert.deepEqual(p.files.read("safe.json"), { value: 1 });
    assert.throws(() => p.files.write("large.json", "x".repeat(4 * 1024 * 1024)), /ledger full/);
    symlinkSync(join(p.root, "safe.json"), join(p.root, "link.json")); assert.throws(() => p.files.read("link.json"));
    linkSync(join(p.root, "safe.json"), join(p.root, "hard.json")); assert.throws(() => p.files.read("hard.json"), /Unsafe private file/);
    writeFileSync(join(p.root, "open.json"), "{}"); chmodSync(join(p.root, "open.json"), 0o644); assert.throws(() => p.files.read("open.json"), /Unsafe private file/);
    assert.throws(() => p.files.read("../safe.json"), /Invalid private filename/);
    chmodSync(p.root, 0o755); assert.throws(() => p.files.read("safe.json"), /mode 0700/); chmodSync(p.root, 0o700);
  } finally { p.cleanup(); }
});
test("one consumer uses kernel-owned lock, release never deletes replacement inode or trusts PID", () => {
  const p = profile();
  try {
    const release = p.files.acquire(); assert.throws(() => p.files.acquire(), /already owned/);
    renameSync(join(p.root, "consumer.json"), join(p.root, "old.json"));
    writeFileSync(join(p.root, "consumer.json"), JSON.stringify({ pid: process.pid, reservation: "PID-reuse-is-irrelevant" }), { mode: 0o600 });
    assert.equal(p.files.ownsConsumer(), false); assert.throws(() => p.files.read("tokens.json"), /lock replaced/);
    release(); release(); assert.match(readFileSync(join(p.root, "consumer.json"), "utf8"), /PID-reuse/);
    const next = p.files.acquire(); next();
  } finally { p.cleanup(); }
});
test("kernel releases a synthetic crashed consumer without stale lease/PID reuse recovery", async () => {
  const p = profile();
  const module = new URL("../src/storage.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", `import {PrivateFiles} from ${JSON.stringify(module)}; const files=new PrivateFiles(${JSON.stringify(p.root)}); files.acquire(); process.send('locked'); process.exit(7);`], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let diagnostic = ""; child.stderr?.on("data", bytes => { diagnostic += String(bytes); });
  try {
    const exit = once(child, "exit");
    await Promise.race([once(child, "message"), exit.then(() => { throw new Error(`Synthetic child failed before IPC: ${diagnostic}`); })]);
    const [code] = await exit; assert.equal(code, 7);
    const release = p.files.acquire(); release();
  } finally { p.cleanup(); }
});
test("descriptor-rooted store refuses renamed/replaced profile", () => {
  const p = profile();
  try { renameSync(p.root, `${p.root}-old`); mkdirSync(p.root, { mode: 0o700 }); assert.throws(() => p.files.write("ledger.json", {}), /directory replaced/); }
  finally { p.cleanup(); }
});
