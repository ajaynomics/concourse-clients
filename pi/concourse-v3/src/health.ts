import { randomUUID } from "node:crypto";
import type { Config } from "./auth.ts";
import { SafeError } from "./http.ts";
import type { PrivateFiles } from "./storage.ts";

export type Channel = "identity" | "inbox" | "answers";
export interface ChannelHealth {
  state: "unknown" | "checking" | "ok" | "failed";
  lastAttemptAt?: number; lastSuccessAt?: number; failureStartedAt?: number; code?: string;
}
export interface HealthSnapshot {
  version: 1;
  origin: string; organization: string; owner: string; agent: string;
  sessionId: string; generation: string; startedAt: number; updatedAt: number;
  lifecycle: "running" | "stopped";
  staleAfterMs: number;
  identity: ChannelHealth; inbox: ChannelHealth; answers: ChannelHealth;
  blockedInbox: number; blockedAnswers: number;
  oauthCode?: "OAUTH_EXCHANGE_UNCERTAIN" | "OPERATOR_OAUTH_REQUIRED";
}
export function safeCode(error: unknown): string {
  return error instanceof SafeError && /^[A-Z][A-Z0-9_]{0,62}(?![\s\S])/.test(error.code) ? error.code : "LOCAL_OPERATION_FAILED";
}
// Readers must evaluate freshness at read time: a dead writer cannot mark itself stale.
export function channelState(snapshot: HealthSnapshot, channel: Channel, now = Date.now()): ChannelHealth["state"] | "stale" | "stopped" | "blocked" {
  if (snapshot.lifecycle !== "running") return "stopped";
  const c = snapshot[channel];
  if (now < snapshot.updatedAt || now - snapshot.updatedAt > snapshot.staleAfterMs || c.lastAttemptAt !== undefined && (now < c.lastAttemptAt || now - c.lastAttemptAt > snapshot.staleAfterMs)) return "stale";
  if (c.state !== "ok") return c.state;
  if (snapshot.oauthCode || channel === "inbox" && snapshot.blockedInbox || channel === "answers" && snapshot.blockedAnswers) return "blocked";
  if (channel !== "identity" && channelState(snapshot, "identity", now) !== "ok") return "blocked";
  return "ok";
}

// No previous-generation success, content, IDs of correspondence, or remote text.
export class Health {
  readonly snapshot: HealthSnapshot;
  private readonly ownerEpoch: string;
  constructor(private files: PrivateFiles, config: Config, sessionId: string, private guard: () => void, private now = Date.now) {
    const at = now();
    this.ownerEpoch = files.consumerEpoch();
    this.snapshot = { version: 1, origin: config.origin, organization: config.organization, owner: config.owner, agent: config.agent,
      sessionId, generation: randomUUID(), startedAt: at, updatedAt: at, lifecycle: "running", staleAfterMs: 180_000,
      identity: { state: "unknown" }, inbox: { state: "unknown" }, answers: { state: "unknown" }, blockedInbox: 0, blockedAnswers: 0 };
  }
  write(): void {
    this.guard();
    if (!this.files.ownsConsumer(this.ownerEpoch)) throw new SafeError("HEALTH_OWNERSHIP_LOST");
    this.snapshot.updatedAt = this.now();
    if (Buffer.byteLength(JSON.stringify(this.snapshot)) > 16 * 1024) throw new SafeError("HEALTH_SIZE_LIMIT");
    this.files.write("health.json", this.snapshot);
  }
  attempt(channel: Channel): void {
    const c = this.snapshot[channel]; c.state = "checking"; c.lastAttemptAt = this.now(); this.write();
  }
  success(channel: Channel): void {
    const c = this.snapshot[channel]; c.state = "ok"; c.lastSuccessAt = this.now(); delete c.failureStartedAt; delete c.code; this.write();
  }
  failure(channel: Channel, error: unknown): void {
    const c = this.snapshot[channel]; c.state = "failed"; c.failureStartedAt ??= this.now(); c.code = safeCode(error); this.write();
  }
  stop(): void { this.snapshot.lifecycle = "stopped"; this.write(); }
}