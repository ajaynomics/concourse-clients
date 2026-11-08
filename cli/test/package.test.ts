import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), ".."), root = dirname(cli);
const pkg = JSON.parse(readFileSync(join(cli, "package.json"), "utf8"));

test("the package runs on plain Node 24 with one pinned runtime dependency", () => {
  assert.equal(pkg.name, "concourse-cli"); assert.equal(pkg.private, false); assert.equal(pkg.license, "MIT"); assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.bin, { concourse: "dist/cli/src/bin.js" });
  assert.deepEqual(pkg.engines, { node: ">=24" });
  assert.deepEqual(pkg.files, ["dist/", "README.md", "LICENSE", "NOTICE"]);
  assert.deepEqual(pkg.dependencies, { "@a2a-js/sdk": "1.3.0" }, "exact pin; Pi and typebox are not dependencies");
  assert.ok(!JSON.stringify(pkg).includes("@earendil-works") && !JSON.stringify(pkg).includes("typebox"));
  const lock = JSON.parse(readFileSync(join(cli, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/@a2a-js/sdk"].version, "1.3.0");
});

test("the licence and notice ship unchanged", () => {
  for (const name of ["LICENSE", "NOTICE"]) assert.equal(readFileSync(join(cli, name), "utf8"), readFileSync(join(root, name), "utf8"), name);
  const readme = readFileSync(join(cli, "README.md"), "utf8");
  assert.match(readme, /NOTICE/); assert.match(readme, /private Concourse server/);
  assert.doesNotMatch(readme, /\/data\/projects|\/home\/|script\/concourse-v3|pi\/concourse-v3/, "no internal paths");
});

// Everything the CLI loads, followed through relative imports, stays clear of Pi.
test("the CLI's import graph never reaches Pi, its TUI or typebox", () => {
  const seen = new Set<string>(), queue = [join(cli, "src/bin.ts")], external = new Set<string>();
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue; seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec)); else external.add(spec);
    }
  }
  const shared = [...seen].filter(f => f.startsWith(join(root, "pi/"))).map(f => f.slice(root.length + 1)).sort();
  assert.ok(shared.includes("pi/concourse-v3/src/auth.ts") && shared.includes("pi/concourse-v3/src/storage.ts") && shared.includes("pi/concourse-v3/src/client.ts") && shared.includes("pi/concourse-v3/src/onboarding.ts"));
  for (const pi of ["delivery.ts", "render.ts", "runtime.ts"]) assert.ok(!shared.includes(`pi/concourse-v3/src/${pi}`), pi);
  assert.ok(!shared.includes("pi/concourse-v3/cli.ts") && !shared.includes("pi/concourse-v3/index.ts"));
  assert.deepEqual([...external].filter(s => !s.startsWith("node:")).sort(), ["@a2a-js/sdk", "@a2a-js/sdk/client"]);
});
