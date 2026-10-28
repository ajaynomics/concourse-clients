import type { Ledger } from "./types.ts";

// One footer line. Pi shows status values without their keys, so the line names the
// service and agent itself. Live means the doorbell is connected, not that Pi is idle.
export interface StatusView { handle: string; host: string; live: boolean; checkedAt?: number; lastOkAt?: number; error?: string; failures: number }

export function attention(l: Ledger, sessionId: string): { mail: number; unconfirmed: number; blocked: number } {
  return {
    mail: Object.values(l.batches).filter(b => b.sessionId === sessionId && b.phase === "handed-off").length,
    unconfirmed: Object.values(l.outgoing).filter(o => ["prepared", "uncertain"].includes(o.phase)).length + Object.values(l.replies ?? {}).filter(r => ["prepared", "uncertain"].includes(r.phase)).length,
    blocked: Object.keys(l.blockedInbox ?? {}).length + Object.keys(l.blockedAnswers ?? {}).length,
  };
}

export function statusLine(v: StatusView, a: ReturnType<typeof attention>): string {
  const who = `Concourse ${v.failures ? "⚠" : "✓"} ${v.handle} @ ${v.host}`;
  const notes = [
    ...(a.unconfirmed ? [`${a.unconfirmed} unconfirmed: /concourse-v3 status`] : []),
    ...(a.blocked ? [`${a.blocked} blocked`] : []),
  ];
  if (v.failures) {
    const last = v.lastOkAt ? ` · last ok ${clock(v.lastOkAt)}` : "";
    return [`${who} ${v.failures} failed check${v.failures === 1 ? "" : "s"} (${shorten(v.error ?? "unknown", 60)})${last}`, ...notes].join(" · ");
  }
  if (!v.checkedAt) return [who, "starting", ...notes].join(" · ");
  return [who, v.live ? "⚡ push" : "polling", `checked ${clock(v.checkedAt)}`, ...(a.mail ? [`mail ${a.mail}`] : []), ...notes].join(" · ");
}

function clock(at: number): string { return new Date(at).toTimeString().slice(0, 5); }
function shorten(s: string, n: number): string { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
