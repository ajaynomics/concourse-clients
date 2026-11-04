import { createServer, type Server } from "node:http";
import { SafeError, validOrganizationSlug } from "./http.ts";
import { AUTHORIZATION_WINDOW_MS } from "./auth.ts";

interface Pending { path: string; keys: string[]; state: string; expires: number; issuer?: string; complete(params: URLSearchParams): Promise<void>; resolve(params: URLSearchParams): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; cleanup(): void }
// RFC 8252: bind the IPv4 loopback listener before registering its exact redirect.
// No raw requests, OAuth codes or provider errors enter diagnostics.
export class Loopback {
  private server: Server;
  private pending?: Pending;
  private closed = false;
  port = 0;
  constructor() {
    this.server = createServer({ maxHeaderSize: 4096 }, (req, res) => {
      const reject = () => { res.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" }); res.end("Callback refused"); };
      const p = this.pending;
      if (!p || Date.now() >= p.expires || req.method !== "GET" || req.headers["transfer-encoding"] || (req.headers["content-length"] && req.headers["content-length"] !== "0") || req.headers.host !== `127.0.0.1:${this.port}` || req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "host").length !== 1 || !req.url || req.url.length > 8192 || !req.url.startsWith(`${p.path}?`)) return reject();
      let url: URL;
      try { url = new URL(req.url, `http://127.0.0.1:${this.port}`); } catch { return reject(); }
      const q = url.searchParams;
      const denial = p.path === "/callback" && q.has("error");
      const keys = denial ? ["error", "state", "iss", "error_description", "error_uri"] : p.keys;
      const required = denial ? ["error", "state", "iss"] : p.keys;
      if (url.pathname !== p.path || url.hash || [...q.keys()].some(k => !keys.includes(k) || q.getAll(k).length !== 1) || required.some(k => q.getAll(k).length !== 1) || q.get("state") !== p.state) return reject();
      if (p.path === "/callback") {
        if (q.get("iss") !== p.issuer) return reject();
        if (denial) {
          // RFC 6749 §4.1.2.1 / RFC 9207: denial is a separate issuer/state-bound
          // response, never a code exchange. Provider text stays out of results.
          const e = q.get("error")!;
          if (!e.trim() || e.length > 256 || /[^\x20-\x21\x23-\x5b\x5d-\x7e]/.test(e)) return reject();
          for (const key of ["error_description", "error_uri"]) {
            const value = q.get(key);
            if (value !== null && (value.length > 2048 || /[^\x20-\x21\x23-\x5b\x5d-\x7e]/.test(value))) return reject();
          }
        } else if (!q.get("code") || q.get("code")!.length > 4096 || /[\x00-\x20\x7f]/.test(q.get("code")!)) return reject();
      }
      if (p.path === "/setup-complete" && !validOrganizationSlug(q.get("organization"))) return reject();
      // A valid callback consumes only this listener's pending slot. TokenClient
      // separately persists its exchange fence before sending the code.
      this.pending = undefined; clearTimeout(p.timer); p.cleanup();
      const done = () => {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'" });
        res.end("Return to the Concourse terminal.");
      };
      if (denial) { done(); p.reject(new SafeError("AUTHORIZATION_DENIED")); return; }
      void p.complete(q).then(() => { done(); p.resolve(q); }, error => { reject(); p.reject(error); });
    });
    this.server.requestTimeout = 5000; this.server.headersTimeout = 5000; this.server.keepAliveTimeout = 1000;
    this.server.maxConnections = 8;
    this.server.on("clientError", (_error, socket) => { socket.destroy(); });
  }
  async bind(port = 0): Promise<void> {
    if (this.closed || (port !== 0 && (!Number.isInteger(port) || port < 1024 || port > 65535))) throw new SafeError("INVALID_CALLBACK_PORT");
    await new Promise<void>((resolve, reject) => {
      const failed = () => { this.server.off("listening", ready); reject(new SafeError("CALLBACK_PORT_UNAVAILABLE")); };
      const ready = () => { this.server.off("error", failed); resolve(); };
      this.server.once("error", failed); this.server.once("listening", ready); this.server.listen(port, "127.0.0.1");
    });
    const address = this.server.address();
    if (!address || typeof address === "string" || address.port < 1024) { await this.close(); throw new SafeError("INVALID_CALLBACK_PORT"); }
    this.port = address.port;
  }
  wait(path: "/callback" | "/setup-complete", state: string, timeoutMs: number, signal?: AbortSignal, complete: (params: URLSearchParams) => Promise<void> = async () => {}, issuer?: string): Promise<URLSearchParams> {
    if (this.closed || this.pending || !this.port || !/^[A-Za-z0-9_-]{32,128}$/.test(state) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AUTHORIZATION_WINDOW_MS) throw new SafeError("INVALID_CALLBACK_WAIT");
    return new Promise((resolve, reject) => {
      const cancel = () => { if (this.pending === pending) this.pending = undefined; clearTimeout(pending.timer); pending.cleanup(); reject(new SafeError("SETUP_CANCELLED")); };
      const pending: Pending = { path, keys: path === "/callback" ? ["code", "state", "iss"] : ["state", "organization"], state, expires: Date.now() + timeoutMs, issuer, complete, resolve, reject, timer: setTimeout(() => { if (this.pending === pending) this.pending = undefined; pending.cleanup(); reject(new SafeError("CALLBACK_TIMEOUT")); }, timeoutMs), cleanup: () => signal?.removeEventListener("abort", cancel) };
      this.pending = pending; signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    });
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    if (this.pending) { const p = this.pending; this.pending = undefined; clearTimeout(p.timer); p.cleanup(); p.reject(new SafeError("SETUP_CANCELLED")); }
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
