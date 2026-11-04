import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { Loopback } from "../src/loopback.ts";
import { SafeError } from "../src/http.ts";
import { loopbackAddress } from "../src/callback.ts";
import { main, parseArgs } from "../cli.ts";

const issuer = "https://app.krishnan.ca", state = "s".repeat(43), code = "synthetic-one-time-code";
const query = new URLSearchParams({ code, state, iss: issuer }).toString();
const noProcess = async () => { throw new Error("No process spawn"); };
async function run(url: string): Promise<Record<string, unknown>> {
  const output: string[] = [];
  await main(["callback", "--url", url, "--json"], noProcess, line => output.push(line));
  assert.equal(output.length, 1);
  for (const secret of [code, state]) assert.equal(output[0].includes(secret), false, "never echo the code or state");
  return JSON.parse(output[0]);
}

test("callback strictly accepts only an exact loopback redirect address", () => {
  for (const url of [`http://127.0.0.1:4444/callback?${query}`, `http://127.0.0.1:65535/setup-complete?state=${state}&organization=team`]) assert.equal(loopbackAddress(url).hostname, "127.0.0.1");
  for (const url of [
    `https://127.0.0.1:4444/callback?${query}`, `HTTP://127.0.0.1:4444/callback?${query}`, `http://localhost:4444/callback?${query}`,
    `http://127.1:4444/callback?${query}`, `http://127.0.0.2:4444/callback?${query}`, `http://[::1]:4444/callback?${query}`,
    `http://user:pass@127.0.0.1:4444/callback?${query}`, `http://127.0.0.1@evil.invalid:4444/callback?${query}`,
    `http://127.0.0.1/callback?${query}`, `http://127.0.0.1:80/callback?${query}`, `http://127.0.0.1:1023/callback?${query}`, `http://127.0.0.1:65536/callback?${query}`, `http://127.0.0.1:04444/callback?${query}`,
    `http://127.0.0.1:4444/other?${query}`, `http://127.0.0.1:4444/callback/?${query}`, `http://127.0.0.1:4444/x/../callback?${query}`, `http://127.0.0.1:4444/%63allback?${query}`,
    "http://127.0.0.1:4444/callback", "http://127.0.0.1:4444/callback?", `http://127.0.0.1:4444/callback?${query}#fragment`,
    `http://127.0.0.1:4444/callback?${query} `, `http://127.0.0.1:4444/callback?${query}\u00e9`, `http://127.0.0.1:4444/callback?${"x".repeat(3100)}`,
  ]) assert.throws(() => loopbackAddress(url), (e: unknown) => e instanceof SafeError && e.code === "CALLBACK_URL_REFUSED" && !e.message.includes(code), url);
});

test("callback needs no profile and is listed in help", async () => {
  assert.deepEqual(parseArgs(["callback", "--url", `http://127.0.0.1:4444/callback?${query}`, "--json"]).url, `http://127.0.0.1:4444/callback?${query}`);
  for (const argv of [["callback"], ["callback", "--profile", "/x/concourse-v3/p", "--url", "u"], ["callback", "--url"]]) assert.throws(() => parseArgs(argv));
  const output: string[] = []; await main(["help"], noProcess, line => output.push(line));
  assert.match(output[0], /script\/concourse-v3 callback --url/);
  const refused = await run(`https://127.0.0.1:4444/callback?${query}`);
  assert.deepEqual([refused.phase, refused.error, refused.uncertain], ["blocked", "CALLBACK_URL_REFUSED", false]);
});

test("one pasted address completes the waiting listener once; a second paste is refused", async () => {
  const listener = new Loopback(); await listener.bind();
  try {
    const received: string[] = [];
    const wait = listener.wait("/callback", state, 5000, undefined, async q => { received.push(q.get("code")!); }, issuer);
    const url = `http://127.0.0.1:${listener.port}/callback?${query}`;
    assert.deepEqual(await run(url), { phase: "complete", command: "callback", accepted: true });
    assert.equal((await wait).get("code"), code); assert.deepEqual(received, [code]);
    const again = await run(url);
    assert.deepEqual([again.error, again.uncertain], ["CALLBACK_REFUSED", false]); assert.match(String(again.recovery), /used already/);
  } finally { await listener.close(); }
});

test("web admission continuation can be pasted back too", async () => {
  const listener = new Loopback(); await listener.bind();
  try {
    const wait = listener.wait("/setup-complete", state, 5000);
    assert.equal((await run(`http://127.0.0.1:${listener.port}/setup-complete?state=${state}&organization=example-team`)).phase, "complete");
    assert.equal((await wait).get("organization"), "example-team");
  } finally { await listener.close(); }
});

test("callback distinguishes no listener and another local service, and never claims acceptance", async () => {
  const other = createServer((_req, res) => { res.writeHead(200); res.end("some other local app"); });
  await new Promise<void>(resolve => other.listen(0, "127.0.0.1", resolve));
  const port = (other.address() as { port: number }).port;
  try {
    const foreign = await run(`http://127.0.0.1:${port}/callback?${query}`);
    assert.deepEqual([foreign.phase, foreign.error, foreign.uncertain], ["blocked", "CALLBACK_NOT_CONCOURSE", false]);
  } finally { await new Promise(resolve => other.close(resolve)); }
  const closed = await run(`http://127.0.0.1:${port}/callback?${query}`);
  assert.deepEqual([closed.error, closed.uncertain], ["CALLBACK_LISTENER_NOT_RUNNING", false]);
  assert.match(String(closed.recovery), /computer where join or signup is still waiting/);
});
