import { object, type Message, type ObjectValue, type Task } from "./types.ts";

// Snapshots retain prior output. Use the same status-bound selection for offering and rendering a reply.
export function taskOutput(task: Task): { message?: Message; artifacts: ObjectValue[] } {
  const output = task.metadata?.["concourse.output"];
  if (!object(output) || typeof task.status.timestamp !== "string" || output.statusTimestamp !== task.status.timestamp || !Array.isArray(output.messageIds) || !Array.isArray(output.artifactIds)) return { artifacts: [] };
  const messageIds = output.messageIds, artifactIds = output.artifactIds;
  const message = task.status.message;
  return {
    message: message?.role === "ROLE_AGENT" && messageIds.includes(message.messageId) ? message : undefined,
    artifacts: (task.artifacts ?? []).filter(a => artifactIds.includes(a.artifactId)),
  };
}
