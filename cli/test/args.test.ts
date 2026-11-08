import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listState, parse, profilePath, resolveProfile, taskState, STATES } from "../src/args.ts";
import { parseArgs as launcherArgs } from "../../pi/concourse-v3/cli.ts";
import { cli, noNetwork, profile } from "./fixture.ts";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("commands take positionals and options in any order, with global options anywhere", () => {
  assert.deepEqual(parse(["--profile", "me", "send", "other/agent", "Hello there", "--json", "--wait", "--timeout=30"]), { command: "send", args: { recipient: "other/agent", text: "Hello there" }, flags: { wait: true, timeout: "30" }, json: true, profile: "me" });
  assert.deepEqual(parse(["reply", "--state", "completed", "id", "-"]).args, { task: "id", text: "-" });
  assert.deepEqual(parse(["send", "a/b", "--", "--not an option"]).args, { recipient: "a/b", text: "--not an option" });
  assert.equal(parse(["agents"]).args.query, undefined);
  assert.equal(parse(["send", "a/b", "line one\nline two"]).args.text, "line one\nline two");
});

test("help and version need no profile, platform or network", async t => {
  noNetwork(t);
  assert.equal(parse([]).command, "help");
  assert.deepEqual([parse(["help", "send"]).topic, parse(["send", "--help"]).topic], ["send", "send"]);
  const home = "/nonexistent";
  for (const argv of [["--help"], ["help"], [], ["-h"]]) {
    const r = await cli(argv, { home, platform: "darwin" });
    assert.equal(r.code, 0); assert.match(r.text, /^Usage: concourse COMMAND/); assert.match(r.text, /approve AGENT_ID/);
    assert.doesNotMatch(r.text, /\b(start|install)\b/, "Pi's start/install are not part of this package");
  }
  const one = await cli(["help", "reply"], { home });
  assert.match(one.text, /--state completed\|input-required\|working\|failed\|rejected/);
  assert.deepEqual((await cli(["--version"], { home, platform: "darwin" })).out, [version]);
});

test("argument mistakes exit 64 before any profile or network use", async t => {
  noNetwork(t);
  const p = profile(t);
  const refuse = async () => { throw new Error("no request expected"); };
  for (const argv of [
    ["frobnicate"], ["send"], ["send", "a/b"], ["send", "a/b", "x", "extra"], ["get"], ["send", "a/b", "x", "--bogus"],
    ["--wait", "send", "a/b", "x"], ["send", "a/b", "x", "--task"], ["send", "a/b", "x", "--task", "--wait"],
    ["inbox", "--json=yes"], ["inbox", "--page-token", "a", "--page-token", "b"], ["get", "id\u001b[2J"],
    ["reply", "00000000-0000-4000-8000-000000000001", "done"], ["reply", "00000000-0000-4000-8000-000000000001", "done", "--state", "canceled"],
    ["reply", "00000000-0000-4000-8000-000000000001", "--state", "input-required"], ["tasks", "--status", "finished"],
    ["send", "a/b", "x", "--timeout", "5"], ["send", "a/b", "x", "--wait", "--timeout", "0"], ["send", "a/b", "   "],
    ["approve", "7abc"], ["decline", "0"], ["retire", "1.5"], ["join"], ["join", "--agent", "Bad Name"], ["inbox", "--profile", "../escape"],
  ]) {
    const r = await cli(argv, { home: p.home, fetchImpl: refuse, stdin: async () => "" });
    assert.equal(r.code, 64, argv.join(" ")); assert.match(r.err.join("\n"), /^Error: INVALID_ARGUMENTS\n\S/, argv.join(" "));
  }
  for (const [argv, code] of [[["get", "abc"], "FULL_TASK_ID_REQUIRED"], [["send", "https://example.invalid/agent", "x"], "QUALIFIED_RECIPIENT_REQUIRED"], [["send", "a/b", "x", "--task", "short"], "FULL_TASK_ID_REQUIRED"], [["join", "--agent", "a", "--organization", "Not A Slug"], "INVALID_ORGANIZATION"]] as const) {
    const r = await cli([...argv, "--json"], { home: p.home, fetchImpl: refuse });
    assert.equal(r.code, 64, argv.join(" ")); assert.match(r.last().error, new RegExp(`^${code}`));
  }
  const machine = await cli(["frobnicate", "--json"], { home: p.home });
  assert.deepEqual(Object.keys(machine.last()), ["phase", "error", "uncertain", "recovery"]);
  assert.equal(machine.last().phase, "blocked");
});

test("state names map to A2A task states", () => {
  assert.deepEqual(STATES.map(s => taskState(s, STATES)), ["TASK_STATE_COMPLETED", "TASK_STATE_INPUT_REQUIRED", "TASK_STATE_WORKING", "TASK_STATE_FAILED", "TASK_STATE_REJECTED"]);
  assert.equal(taskState("TASK_STATE_FAILED", STATES), "TASK_STATE_FAILED");
  assert.equal(listState("auth-required"), "TASK_STATE_AUTH_REQUIRED");
  assert.throws(() => taskState("canceled", STATES), /Unknown state/);
});

test("profiles follow the Pi extension's convention: a name, CONCOURSE_PROFILE, or the only one", t => {
  const p = profile(t, "first"), root = join(p.home, ".local/state/concourse-v3");
  // The same default path the repository launcher's join uses.
  assert.equal(resolveProfile(undefined, { HOME: p.home }, "my-agent"), launcherArgs(["join", "--agent", "my-agent"], p.home).options.profile);
  assert.equal(profilePath("/abs/concourse-v3/x", undefined), "/abs/concourse-v3/x");
  assert.equal(resolveProfile("other", { HOME: p.home, CONCOURSE_PROFILE: "first" }), join(root, "other"));
  assert.equal(resolveProfile(undefined, { HOME: p.home, CONCOURSE_PROFILE: "chosen" }), join(root, "chosen"));
  assert.equal(resolveProfile(undefined, { HOME: p.home }), p.root, "the only signed-in profile");
  mkdirSync(join(root, "draft-only"), { mode: 0o700 });
  assert.equal(resolveProfile(undefined, { HOME: p.home }), p.root, "an unfinished draft is never chosen");
  mkdirSync(join(root, "second"), { mode: 0o700 });
  const second = join(root, "second", "config.json");
  mkdirSync(second, { mode: 0o700 }); // stands in for a finished profile without writing a credential
  assert.throws(() => resolveProfile(undefined, { HOME: p.home }), (e: any) => e.code === "PROFILE_REQUIRED" && /first, second/.test(e.hint));
  assert.throws(() => resolveProfile(undefined, {}), /HOME is not set/);
  assert.throws(() => profilePath("a/b", p.home), /--profile takes/);
});

test("profile commands refuse other platforms and missing profiles plainly", async t => {
  noNetwork(t);
  const p = profile(t);
  const mac = await cli(["inbox"], { home: p.home, platform: "darwin" });
  assert.equal(mac.code, 1); assert.match(mac.err[0], /REQUIRES_LINUX_NODE_24\nConcourse profiles need Linux/);
  const missing = await cli(["inbox", "--profile", "nobody", "--json"], { home: p.home });
  assert.equal(missing.code, 1); assert.equal(missing.last().error, "PROFILE_NOT_FOUND"); assert.match(missing.last().recovery, /concourse join --agent NAME/);
  mkdirSync(join(p.home, ".local/state/concourse-v3/draft"), { mode: 0o700 });
  const draft = await cli(["inbox", "--profile", "draft", "--json"], { home: p.home });
  assert.equal(draft.last().error, "PROFILE_NOT_CONFIGURED");
});
