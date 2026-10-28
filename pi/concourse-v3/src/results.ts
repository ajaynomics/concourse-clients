import { object, type Json } from "./types.ts";

export function toolResult(name: string, value: unknown) {
  const structuredContent = { result: value as Json };
  let visible: unknown = value;
  if (["send", "reply", "cancel"].includes(name)) {
    const raw = object(value) && "result" in value ? value.result : value;
    visible = { ...(object(value) && typeof value.messageId === "string" ? { messageId: value.messageId } : {}), ...(object(value) && value.warning ? { warning: value.warning } : {}),
      ...(object(raw) && object(raw.status) ? { taskId: raw.id, contextId: raw.contextId, state: raw.status.state, message: raw.status.message, artifacts: raw.artifacts } : { response: raw }) };
  }
  const json = JSON.stringify(visible);
  const text = json.length <= 16_384 ? json : `${json.slice(0, 16_384)}\n[Display truncated; full result is in structuredContent.result via codemode. Do not infer omitted content.]`;
  return { content: [{ type: "text" as const, text: `Concourse v3 ${name}:\n${text}` }], details: structuredContent, structuredContent };
}
