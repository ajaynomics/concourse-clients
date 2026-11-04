import { boundedBytes, SafeError } from "./http.ts";

// The exact text Loopback answers after it accepts a callback; anything else is another service.
export const LOOPBACK_ACCEPTED = "Return to the Concourse terminal.";
// Raw-string checks, not just URL parsing: the parser would turn 127.1, ../ or HTTP: into
// an acceptable address. The query carries the one-time code and state; never print it.
const shape = /^http:\/\/127\.0\.0\.1:(\d{4,5})(\/callback|\/setup-complete)\?[\x21-\x22\x24-\x7e]+$/;
export function loopbackAddress(raw: string): URL {
  const match = typeof raw === "string" && raw.length <= 3072 ? shape.exec(raw) : null;
  const port = Number(match?.[1]);
  let url: URL | undefined;
  try { url = match ? new URL(raw) : undefined; } catch { /* refused below */ }
  if (!match || !url || port < 1024 || port > 65535 || url.port !== match[1] || url.pathname !== match[2] || url.username || url.password || url.hash || !url.search) throw new SafeError("CALLBACK_URL_REFUSED", false, undefined, {}, "Give the full address the browser ended on. It starts with http://127.0.0.1: and contains /callback? or /setup-complete?.");
  return url;
}
// One GET hands a remote browser's redirect to the listener waiting on this host. The listener
// validates state/issuer and consumes its pending slot itself, so a second paste is refused.
export async function deliverCallback(raw: string, fetchImpl: typeof fetch = fetch): Promise<{ accepted: true }> {
  const url = loopbackAddress(raw);
  let response: Response;
  try { response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(60_000) }); }
  catch (e) {
    // Connection refused means nothing received the address; any later failure may have.
    if ((e as { cause?: { code?: string } })?.cause?.code === "ECONNREFUSED") throw new SafeError("CALLBACK_LISTENER_NOT_RUNNING", false, undefined, {}, "Nothing is waiting at that address on this computer. Run this on the computer where join or signup is still waiting.");
    throw new SafeError("CALLBACK_OUTCOME_UNKNOWN", true, undefined, {}, "Check the waiting join or signup output before trying again.");
  }
  let text = "";
  try { text = new TextDecoder().decode(await boundedBytes(response, 1024)); } catch { /* judged by status below */ }
  if (response.status === 200 && text === LOOPBACK_ACCEPTED) return { accepted: true };
  if (response.status === 400 && text === "Callback refused") throw new SafeError("CALLBACK_REFUSED", false, undefined, {}, "The waiting sign-in did not accept this address. It may have expired, been used already or belong to another sign-in. Check the join or signup output; if it stopped, run join again.");
  throw new SafeError("CALLBACK_NOT_CONCOURSE", false, undefined, {}, "Something other than a waiting Concourse sign-in answered at that address. Check the address and where join or signup is running.");
}
