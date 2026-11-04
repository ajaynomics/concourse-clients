import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type Provider, type Model, type Api, type TranscriptContext, type ToolCall } from "@earendil-works/pi-ai";
import v3Extension from "../index.ts";
import { FileJournal, PrivateFiles } from "../src/storage.ts";
import { config, deferred, outboundGuard, syntheticToken, WireFixture } from "./sdk-seams-fixture-20261012.ts";

export const fakeModel: Model<Api> = { id: "sdk-only-synthetic", name: "No real model", provider: "v3-sdk-fixture", api: "v3-sdk-fixture", baseUrl: "https://model.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1000 };
export interface ScriptResult { calls?: ToolCall[]; text?: string; gate?: ReturnType<typeof deferred<void>> }
export type Script = (context: TranscriptContext, index: number) => ScriptResult;
export const toolCall = (name: string, args: ToolCall["arguments"], id = name): ToolCall => ({ type: "toolCall", id, name, arguments: args });

export async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("SYNTHETIC_FIXTURE_DEADLINE")), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

export async function nativeFixture(script: Script = () => ({ text: "Synthetic turn ended without an outcome" }), input: { background?: boolean; inboxEmpty?: boolean; second?: boolean; toolLoadout?: "codemode" | "restored" | "excluded" | "allowlisted" | "only"; defaultSystemPrompt?: boolean } = {}) {
  // All transient SDK/profile/ledger files are private and under the assigned package's test directory.
  const base = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "tmp-sdk-native-20261012-"));
  const root = join(base, "concourse-v3", "sdk-native"), agentDir = join(base, "agent"), cwd = join(base, "workspace");
  for (const path of [root, agentDir, cwd]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const files = new PrivateFiles(root);
  files.write("config.json", config);
  // Synthetic pre-bound token: no issuer, OAuth, credential lookup or grant HTTP is possible.
  files.write("tokens.json", { access: syntheticToken, expires: Date.now() + 3600000, resource: config.origin, clientId: config.oauthClientId, issuer: config.issuer });
  const server = new WireFixture(); if (input.inboxEmpty) server.inbox = [];
  // Optional second personal profile on another synthetic server, with its own Task.
  const secondConfig = { ...config, origin: "https://second.invalid", agent: "second" }, secondRoot = join(base, "concourse-v3", "sdk-second");
  const second = input.second ? { server: new WireFixture(secondConfig), files: (mkdirSync(secondRoot, { mode: 0o700 }), new PrivateFiles(secondRoot)), root: secondRoot } : undefined;
  if (second) {
    second.server.current = { ...second.server.current, id: "00000000-0000-4000-8000-000000000002" }; second.server.inbox = [structuredClone(second.server.current)];
    second.files.write("config.json", secondConfig);
    second.files.write("tokens.json", { access: syntheticToken, expires: Date.now() + 3600000, resource: secondConfig.origin, clientId: config.oauthClientId, issuer: config.issuer });
  }
  const route: typeof server.fetch = (url, init) => (second && new URL(url instanceof Request ? url.url : String(url)).origin === secondConfig.origin ? second.server : server).fetch(url, init);
  const guard = outboundGuard(route), settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", packages: [], defaultProjectTrust: "never", enableAnalytics: false, enableInstallTelemetry: false, ...(input.toolLoadout ? { defaultTools: ["codemode"] } : {}) });
  const contexts: TranscriptContext[] = [], observed: unknown[] = [], errors: unknown[] = [], events: any[] = [];
  const settled = () => {
    const d = deferred<void>(); const unsubscribe = session.subscribe(e => { if (e.type === "agent_settled") { unsubscribe(); d.resolve(); } }); return d.promise;
  };
  let aborted = 0, session!: AgentSession, api!: ExtensionAPI;
  const gates = new Set<ReturnType<typeof deferred<void>>>();
  const provider: Provider = { id: fakeModel.provider, name: "Synthetic fixture provider", getModels: () => [fakeModel],
    auth: { apiKey: { name: "No credential access", resolve: async () => ({ auth: { apiKey: "synthetic-only" }, source: "fixture" }), check: async () => ({ type: "api_key", source: "fixture" }) } },
    stream: () => { throw new Error("Only controlled synthetic streamSimple is supported"); },
    streamSimple(model, context, options) {
      assert.equal(model.provider, fakeModel.provider); assert.equal(model.id, fakeModel.id);
      const index = contexts.length; contexts.push(structuredClone(context));
      const result = script(context, index); if (result.gate) gates.add(result.gate);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", api: fakeModel.api, provider: fakeModel.provider, model: fakeModel.id, timestamp: Date.now(), stopReason: "pending", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        stream.push({ type: "start", partial: message });
        const abort = deferred<void>(); const onAbort = () => { aborted++; abort.resolve(); };
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          if (result.gate) await Promise.race([result.gate.promise, abort.promise]);
          if (options?.signal?.aborted) { message.stopReason = "aborted"; message.errorMessage = "Synthetic fixture canceled"; stream.push({ type: "error", reason: "aborted", error: message }); return; }
          if (result.calls?.length) {
            for (const call of result.calls) {
              const contentIndex = message.content.length; message.content.push(call);
              stream.push({ type: "toolcall_start", contentIndex, partial: message });
              stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
            }
            message.stopReason = "toolUse";
          } else {
            const content = { type: "text" as const, text: result.text ?? "Synthetic fixture final text" }; message.content.push(content);
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: content.text, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: content.text, partial: message });
            message.stopReason = "stop";
          }
          stream.push({ type: "done", reason: message.stopReason, message });
        } finally { options?.signal?.removeEventListener("abort", onAbort); stream.end(message); }
      })();
      return stream;
    },
  };
  try {
    // Use the real prompt builder only when a test checks model-facing guidelines.
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, ...(input.defaultSystemPrompt ? {} : { systemPrompt: "Synthetic SDK test; no external tool/provider execution" }), appendSystemPrompt: [], extensionFactories: [...(input.toolLoadout ? [createCodemodeExtension({ models: false, mode: input.toolLoadout === "only" ? "only" : "on" })] : []), v3Extension, pi => {
      api = pi; pi.registerProvider(provider);
      pi.on("message_start", e => { if (e.message.role === "custom") observed.push(structuredClone(e.message)); });
    }] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    // Native provider registration replaces only the test-owned runtime; every operation is synthetic.
    modelRuntime.registerNativeProvider(provider);
    const sessionManager = SessionManager.inMemory(cwd);
    if (input.toolLoadout === "restored") {
      // A real saved transcript declares codemode but predates the Concourse tools.
      sessionManager.appendMessage({ role: "system", content: "Synthetic saved loadout", toolsAdded: [{ name: "codemode", description: "Saved codemode declaration", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } }], timestamp: Date.now() });
    }
    const created = await createAgentSession({ cwd, agentDir, modelRuntime, model: fakeModel, resourceLoader: loader, settingsManager: settings, sessionManager, ...(input.toolLoadout ? {} : { noTools: "builtin" as const }), ...(input.toolLoadout === "allowlisted" ? { tools: ["codemode"] } : {}), ...(input.toolLoadout === "excluded" ? { excludeTools: ["concourse_v3_*"] } : {}), thinkingLevel: "off" });
    session = created.session;
    session.subscribe(e => events.push(e));
    session.extensionRunner.setFlagValue("concourse-v3-profile", [join(root, "config.json"), ...(second ? [join(secondRoot, "config.json")] : [])].join(","));
    const activeBeforeBind = session.getActiveToolNames();
    await session.bindExtensions({ mode: "print", onError: e => errors.push(e) });
    assert.equal(session.model?.provider, fakeModel.provider);
    if (!input.toolLoadout) assert.ok(session.getActiveToolNames().includes("concourse_v3_reply"));
    await session.prompt("/concourse-v3 refresh");
    return { base, root, files, server, second: second && { ...second, journal: new FileJournal(second.files) }, session, api, contexts, observed, errors, events, guard, settled, activeBeforeBind, journal: new FileJournal(files), get aborted() { return aborted; },
      async cleanup() {
        for (const gate of gates) gate.resolve(); for (const gate of server.operationGates.values()) gate.resolve();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await session.waitForIdle(); session.dispose(); server.close(); second?.server.close(); second?.files.close(); files.close(); guard.close(); rmSync(base, { recursive: true, force: true });
      },
    };
  } catch (e) {
    for (const gate of gates) gate.resolve(); for (const gate of server.operationGates.values()) gate.resolve();
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    server.close(); second?.server.close(); second?.files.close(); files.close(); guard.close(); rmSync(base, { recursive: true, force: true }); throw e;
  }
}
