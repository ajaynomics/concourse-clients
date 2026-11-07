export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export const object = (v: unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);
export interface Message { messageId: string; role: string; parts: ObjectValue[]; metadata?: ObjectValue; taskId?: string; contextId?: string }
export interface Task { id: string; contextId?: string; status: { state: string; timestamp?: string; message?: Message }; history?: Message[]; artifacts?: ObjectValue[]; metadata?: ObjectValue }
export const terminal = (state: string) => ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_REJECTED", "TASK_STATE_CANCELED"].includes(state);
export function task(value: unknown): Task {
  if (!object(value) || typeof value.id !== "string" || !object(value.status) || typeof value.status.state !== "string") throw new Error("Invalid task response");
  return value as unknown as Task;
}
export interface Identity { release_line: 3; network_agent: string; owner: string; organization: string; handle: string; oauth_client_id: string; agent_id: number }
// Older ledgers may hold executor-era phase strings; Mailbox.recover() treats them as uncertain.
export type Phase = "queued" | "uncertain" | "handed-off";
// Content is only needed until hand-off; afterwards the IDs remain as dedupe fences.
export interface Batch { id: string; taskId: string; sessionId: string; messageIds: string[]; messages?: Message[]; artifacts?: ObjectValue[]; contextId?: string; caller: Json; phase: Phase }
export interface Outgoing { messageId: string; recipient: string; expectReply: boolean; taskId?: string; contextId?: string; parts?: ObjectValue[]; phase: "prepared" | "accepted" | "uncertain" | "refused"; resultType?: "task" | "message"; answer?: Json; answerKey?: string; offered?: boolean; delivered?: boolean; observedTerminal?: boolean; directResultUnavailable?: boolean; supersedesQuestions?: string[]; preparedAt?: number; absentAt?: number }
export interface ReplyIntent { id: string; taskId: string; outcome: Outcome; phase: "prepared" | "accepted" | "uncertain" | "refused" }
export interface Ledger { version: 3; batches: Record<string, Batch>; outgoing: Record<string, Outgoing>; cursors: Record<string, string>; seenAnswers: Record<string, boolean>; retiredQuestions?: Record<string, boolean>; observations?: Record<string, number>; polls?: Record<string, { first: number; last: number }>; replies?: Record<string, ReplyIntent>; blockedInbox?: Record<string, { code: string }>; blockedAnswers?: Record<string, { code: string }> }
export interface Outcome { state: string; parts?: ObjectValue[]; artifacts?: ObjectValue[] }
