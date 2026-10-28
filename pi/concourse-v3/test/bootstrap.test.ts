import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("help and the installer bootstrap before dependencies exist; no network or real npm invocation", () => {
  const source = fileURLToPath(new URL("../", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "concourse-bootstrap-"));
  try {
    for (const name of ["cli.ts", "package.json", "src"]) cpSync(join(source, name), join(root, name), { recursive: true });
    mkdirSync(join(root, "home"));
    assert.equal(existsSync(join(root, "node_modules")), false);
    const probe = `
      globalThis.fetch = async () => { throw new Error("Network forbidden"); };
      const { main } = await import(${JSON.stringify(pathToFileURL(join(root, "cli.ts")).href)});
      const calls = [], output = [];
      const run = async (command, args, cwd) => { calls.push({ command, args, cwd }); return 0; };
      const help = await main(["help"], run, line => output.push(line));
      const install = await main(["install"], run, line => output.push(line));
      const invalid = await main(["install", "--global"], run, line => output.push(line));
      console.log(JSON.stringify({ help, install, invalid, calls, output }));
    `;
    const child = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", probe], {
      cwd: root, env: { HOME: join(root, "home"), PATH: dirname(process.execPath) }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.help, 0); assert.equal(result.install, 0); assert.equal(result.invalid, 1);
    assert.match(result.output[0], /script\/concourse-v3 install/);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].command, process.execPath);
    assert.equal(result.calls[0].cwd, root);
    assert.deepEqual(result.calls[0].args.slice(1), ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", root]);
    assert.equal(existsSync(join(root, "node_modules")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
