import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installPlan, main, packageRoot, parseArgs, startPlan } from "../cli.ts";
import { install } from "../index.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { profile, config } from "./helpers.ts";
import { nativeFixture, bounded } from "./sdk-native-fixture-20261012.ts";

test("install is task/repo-local npm ci with the invoking Node, pinned dev runtime and scripts/audit disabled; mock spawn only", async () => {
  const calls: { command: string; args: string[]; cwd?: string }[] = [];
  const result = await main(["install"], async (command, args, cwd) => { calls.push({ command, args, cwd }); return 0; });
  assert.equal(result, 0); assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath); assert.equal(calls[0].cwd, packageRoot);
  assert.match(calls[0].args[0], /npm\/bin\/npm-cli\.js$/);
  assert.deepEqual(calls[0].args.slice(1), ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", packageRoot]);
  assert.equal(installPlan("/explicit/npm-cli.js").command, process.execPath);
});
test("start invokes only package-local qualified Pi with exact extension/config plus normal args, no global profile or runtime", async () => {
  const p = profile();
  try {
    p.files.write("config.json", config);
    const plan = startPlan(p.root, ["--continue", "--model", "synthetic/not-called"]);
    assert.equal(plan.command, process.execPath);
    assert.deepEqual(plan.args, [join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), "-e", join(packageRoot, "index.ts"), "--concourse-v3-profile", join(p.root, "config.json"), "--continue", "--model", "synthetic/not-called"]);
    const calls: string[][] = [];
    assert.equal(await main(["start", "--profile", p.root, "--", "--continue"], async (_cmd, args) => { calls.push(args); return 0; }), 0);
    assert.equal(calls.length, 1); assert.equal(calls[0].at(-1), "--continue");
    const release = p.files.acquire(); assert.throws(() => startPlan(p.root, []), /already owned/); release();
    assert.throws(() => startPlan(p.root, ["--concourse-v3-profile=/different"]), /PROFILE_OVERRIDE_REFUSED/);
  } finally { p.cleanup(); }
});
test("strict CLI contract rejects ambiguous/missing/duplicate flags and profile override; JSON errors never print arguments", async () => {
  assert.deepEqual(parseArgs(["signup", "--profile", "/absolute/concourse-v3/agent", "--resume", "--organization", "team", "--no-open", "--json"]).options, { profile: "/absolute/concourse-v3/agent", resume: true, organization: "team", noOpen: true });
  for (const argv of [["signup", "--profile", "p"], ["signup", "--profile", "p", "--resume", "--profile", "q"], ["install", "--global"], ["doctor"], ["start", "--profile", "p", "--", "--concourse-v3-profile", "q"], ["signup", "--profile", "--resume"]]) assert.throws(() => parseArgs(argv));
  const output: string[] = [];
  assert.equal(await main(["signup", "--json", "--token", "synthetic-secret"], async () => { throw new Error("No child"); }, v => output.push(v)), 1);
  assert.equal(output.length, 1); assert.equal(JSON.parse(output[0]).error, "INVALID_CLI_OPTION"); assert.equal(output[0].includes("synthetic-secret"), false);
});
test("fresh signup supports automatic or explicit provisioned public UID; resume never accepts a client override", async () => {
  const uid = "synthetic-provisioned_UID-123";
  const fresh = ["signup", "--origin", "https://concourse.krishnan.ca", "--profile", "/absolute/concourse-v3/agent", "--agent", "agent"];
  assert.deepEqual(parseArgs([...fresh, "--oauth-client-id", uid]).options, { origin: "https://concourse.krishnan.ca", profile: "/absolute/concourse-v3/agent", agent: "agent", oauthClientId: uid });
  assert.deepEqual(parseArgs(fresh).options, { origin: "https://concourse.krishnan.ca", profile: "/absolute/concourse-v3/agent", agent: "agent" });
  for (const suffix of [["--oauth-client-id"], ["--oauth-client-id", "--json"], ["--oauth-client-id", ""]]) assert.throws(() => parseArgs([...fresh, ...suffix]), /MISSING_OR_INVALID_OPTION_VALUE/);
  assert.throws(() => parseArgs([...fresh, "--oauth-client-id", uid, "--oauth-client-id", uid]), /DUPLICATE_CLI_OPTION/);
  for (const suffix of [["--resume", "--oauth-client-id", uid], ["--oauth-client-id", uid, "--resume"]]) assert.throws(() => parseArgs(["signup", "--profile", "/absolute/concourse-v3/agent", ...suffix]), /RESUME_CLIENT_OVERRIDE_REFUSED/);
  for (const command of ["install", "doctor", "start"]) assert.throws(() => parseArgs([command, "--oauth-client-id", uid, "--profile", "/absolute/concourse-v3/agent"]), /INVALID_CLI_OPTION/);
  assert.throws(() => parseArgs([...fresh, "--oauth-client-id", uid, "--callback-port", "4444"]), /INVALID_CLI_OPTION/, "RFC 8252 loopback remains ephemeral, with no new port option");
  const output: string[] = [];
  const forbidden = async () => { throw new Error("No child or HTTP permitted"); };
  assert.equal(await main([...fresh, "--oauth-client-id", "synthetic.private.input", "--json"], forbidden, line => output.push(line), { fetchImpl: forbidden }), 1);
  assert.equal(JSON.parse(output[0]).error, "PROVISIONED_CLIENT_ID_REQUIRED");
  assert.equal(output[0].includes("synthetic.private.input"), false);
});
test("executable wrapper resolves checkout independently of cwd, requires Node >=24 and runs help without network/install/start", () => {
  const wrapper = fileURLToPath(new URL("../../../script/concourse-v3", import.meta.url));
  const ok = spawnSync(wrapper, ["help"], { cwd: "/", env: { ...process.env, CONCOURSE_V3_NODE: process.execPath }, encoding: "utf8" });
  assert.equal(ok.status, 0); assert.match(ok.stdout, /script\/concourse-v3 signup --origin/); assert.match(ok.stdout, /--oauth-client-id/); assert.match(ok.stdout, /doctor/); assert.match(ok.stdout, /-- normal Pi args/);
  const rejected = spawnSync(wrapper, ["help"], { cwd: "/", env: { ...process.env, CONCOURSE_V3_NODE: "/bin/false" }, encoding: "utf8" });
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /requires Node >=24/);
});
test("slash help works BEFORE runtime/profile/auth and exposes actual setup and mailbox commands", async () => {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const messages: string[] = [];
  const pi = { registerFlag() {}, on() {}, registerTool() {}, registerMessageRenderer() {}, registerCommand(name: string, command: { handler: typeof handler }) { assert.equal(name, "concourse-v3"); handler = command.handler; } } as unknown as ExtensionAPI;
  install(pi, async () => { throw new Error("Help must not call HTTP"); });
  const ctx = { ui: { notify: (v: string) => messages.push(v) } } as unknown as ExtensionCommandContext;
  await handler("help", ctx); assert.equal(messages.length, 1);
  for (const command of ["status", "refresh", "answers", "answer <messageId>", "reconcile <messageId>", "collapse on|off", "script/concourse-v3 install", "--resume", "--oauth-client-id PUBLIC_UID", "operator-provisioned V3 public client"]) assert.ok(messages[0].includes(command));
  const signup = messages[0].split("\n").find(line => line.startsWith("script/concourse-v3 signup --origin"))!;
  assert.equal(parseArgs(signup.replace(/\s*\[[^\]]*\]/g, "").split(/\s+/).slice(1)).options.oauthClientId, undefined);
  await handler("status", ctx); assert.match(messages[1], /V3_NOT_CONNECTED/);
});
test("actual slash status/refresh/answers/answer/reconcile dispatch through the qualified SDK, preserve normal queues and don't invent signup commands", { timeout: 10000 }, async t => {
  const f = await nativeFixture(() => ({ text: "Synthetic model adapter, no provider" }), { background: true, inboxEmpty: true });
  t.after(() => f.cleanup());
  for (const command of ["status", "refresh", "answers", "answer unknown-message", "reconcile unknown-message", "help"]) await bounded(f.session.prompt(`/concourse-v3 ${command}`));
  assert.equal(f.server.calls.some(c => c.method === "POST" && c.url.includes("oauth/register")), false);
  assert.equal(f.aborted, 0); assert.equal(f.server.calls.some(c => c.body?.delivery), false);
  assert.deepEqual(f.errors, []);
});

test("every canonical documented signup command parses with automatic or explicit provisioned mode", () => {
  for (const path of ["README.md", "JOIN-V3.md", "docs/developer-quickstart.md", "pi/concourse-v3/README.md"]) {
    const source = readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    let commands = 0;
    for (const block of source.matchAll(/```sh\r?\n([\s\S]*?)```/g)) {
      for (const line of block[1].replace(/\\\r?\n\s*/g, " ").split(/\r?\n/)) {
        if (!line.startsWith("script/concourse-v3 signup ")) continue;
        const argv = line.match(/"[^"]*"|'[^']*'|\S+/g)!.map(word => word.replace(/^["']|["']$/g, ""));
        const parsed = parseArgs(argv.slice(1)); commands++;
        assert.equal(parsed.command, "signup", path);
        assert.equal(parsed.options.oauthClientId, argv.includes("--oauth-client-id") ? "PUBLIC_UID" : undefined, path);
        if (!parsed.options.resume && !parsed.options.oauthClientId) assert.equal(parsed.options.origin, "https://concourse.krishnan.ca", path);
      }
    }
    assert.ok(commands > 0, `${path} has checked signup examples`);
  }
});

test("one-shot action parser preserves setup grammar and requires explicit bounded options", () => {
  const profile = "/absolute/concourse-v3/agent";
  for (const [command, flags] of [
    ["identity", []], ["find", ["--query", "review"]], ["inbox", ["--page-token", "cursor"]],
    ["list", ["--status", "TASK_STATE_WORKING", "--page-token", "cursor"]], ["task", ["--task-id", "t1"]],
    ["send", ["--recipient", "owner/agent", "--input", "/message.json"]], ["reply", ["--task-id", "t1", "--input", "/outcome.json"]],
    ["cancel", ["--recipient", "owner/agent", "--task-id", "t1"]], ["presence", ["--agent", "owner/agent"]],
    ["receipt", ["--recipient", "owner/agent", "--message-id", "m1"]], ["reconcile-send", ["--message-id", "m1"]],
  ] as const) {
    assert.deepEqual(parseArgs([command, "--profile", profile, ...flags, "--json"]), { command, options: { profile }, json: true, piArgs: [] });
    for (const extra of [["--json", "--json"], ["--token", "private"], ["--", "extra"], ["--profile", profile]]) assert.throws(() => parseArgs([command, "--profile", profile, ...flags, ...extra]));
  }
  for (const argv of [["list", "--status", "completed"], ["list", "--page-token", "x".repeat(2049)], ["task", "--task-id", ".."], ["task", "--task-id", "line\nfeed"], ["send", "--recipient", "owner/agent", "--input", "relative"]]) assert.throws(() => parseArgs([...argv, "--profile", profile]));
  assert.equal(parseArgs(["login", "--profile", profile, "--no-open", "--json"]).command, "login");
  assert.deepEqual(parseArgs(["start", "--profile", profile, "--", "--continue"]).piArgs, ["--continue"]);
});
