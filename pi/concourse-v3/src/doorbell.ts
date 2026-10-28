import type { Config } from "./auth.ts";
import { httpsUrl, SafeError, type Fetch } from "./http.ts";
import { object } from "./types.ts";
// SSE is a lossy data-only hint. Identity and mailbox checks remain independently authenticated.
// Callbacks must not block: the read loop has to keep consuming keepalives or the liveness timer fires.
export async function doorbell(input: { config: Config; sessionId: string; token: string; signal: AbortSignal; fetchImpl?: Fetch; ready(): void; hint(): void }): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)) throw new SafeError("INVALID_SESSION_HEADER");
  const controller = new AbortController();
  const abort = () => controller.abort(); input.signal.addEventListener("abort", abort, { once: true });
  let timer = setTimeout(abort, 15_000), total = 0;
  const max = setTimeout(abort, 15 * 60_000);
  const expected = httpsUrl(input.config.origin).origin;
  try {
    const r = await (input.fetchImpl ?? fetch)(`${expected}/api/doorbell`, { method: "GET", redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${input.token}`, accept: "text/event-stream", "Concourse-Session-Id": input.sessionId } });
    if (!r.ok || r.redirected || (r.url && new URL(r.url).origin !== expected) || !r.headers.get("content-type")?.startsWith("text/event-stream")) { await r.body?.cancel(); throw new SafeError("DOORBELL_REFUSED"); }
    let headerBytes = 0; r.headers.forEach((v, k) => { headerBytes += v.length + k.length; });
    if (headerBytes > 16 * 1024) { await r.body?.cancel(); throw new SafeError("DOORBELL_HEADERS_LIMIT"); }
    const reader = r.body?.getReader(); if (!reader) throw new SafeError("DOORBELL_BODY_REQUIRED");
    let buffer = "", event = "", data: string[] = [], ready = false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read(); if (done) break;
        clearTimeout(timer); timer = setTimeout(abort, 45_000);
        total += value.length; if (total > 1024 * 1024) throw new SafeError("DOORBELL_STREAM_LIMIT");
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 16 * 1024) throw new SafeError("DOORBELL_FRAME_LIMIT");
        let n: number;
        while ((n = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, n).replace(/\r$/, ""); buffer = buffer.slice(n + 1);
          if (!line) {
            if (event === "ready") {
              let b: unknown; try { b = JSON.parse(data.join("\n")); } catch { throw new SafeError("V3_READY_REQUIRED"); }
              if (ready || !object(b) || b.release_line !== 3 || b.sessionId !== input.sessionId || typeof b.connectionId !== "string" || !/^[0-9a-f-]{36}$/i.test(b.connectionId)) throw new SafeError("V3_READY_REFUSED");
              ready = true; input.ready();
            } else if (event === "ping" && ready) input.hint();
            event = ""; data = [];
          } else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) { data.push(line.slice(5).trimStart()); if (data.join("\n").length > 16 * 1024) throw new SafeError("DOORBELL_FRAME_LIMIT"); }
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (e) { if (e instanceof SafeError) throw e; if (!input.signal.aborted) throw new SafeError("DOORBELL_DISCONNECTED"); }
  finally { clearTimeout(timer); clearTimeout(max); input.signal.removeEventListener("abort", abort); controller.abort(); }
}
