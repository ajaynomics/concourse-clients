import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { install } from "../index.ts";

test("mail checks advertise queue effects, unlike passive task reads", () => {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerFlag() {}, on() {}, registerMessageRenderer() {}, registerCommand() {},
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  install(pi, async () => { throw new Error("Registration must not call HTTP"); });
  assert.equal(tools.get("concourse_v3_check")?.annotations?.readOnlyHint, false);
  assert.match(tools.get("concourse_v3_check")!.description, /follow-up queue/);
  for (const name of ["find", "get", "list"]) assert.equal(tools.get(`concourse_v3_${name}`)?.annotations?.readOnlyHint, true);
  for (const tool of tools.values()) assert.equal(tool.executionMode, "sequential");
});
