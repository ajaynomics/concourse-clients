import { SafeError } from "./http.ts";

// Generation-local operations retain ownership until all in-flight writers have drained.
export class Lifetime {
  readonly controller = new AbortController();
  private valid = true;
  private jobs = new Set<Promise<unknown>>();
  constructor(private matches: () => boolean) {}
  alive = (): boolean => this.valid && this.matches();
  check = (): void => { if (!this.alive()) throw new SafeError("SESSION_REPLACED"); };
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.check();
    const job = (async () => { this.check(); return fn(); })();
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
    return job;
  }
  invalidate(): void { this.valid = false; this.controller.abort(); }
  async drain(): Promise<void> { while (this.jobs.size) await Promise.allSettled([...this.jobs]); }
}
