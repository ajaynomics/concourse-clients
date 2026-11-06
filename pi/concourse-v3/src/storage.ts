import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Ledger } from "./types.ts";

export const emptyLedger = (): Ledger => ({ version: 3, batches: {}, outgoing: {}, cursors: {}, seenAnswers: {} });
export interface Journal { load(): Ledger; save(value: Ledger): void }
// Linux descriptor-rooted files and kernel flock; no PID/time leases or profile discovery.
export function privateRoot(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || basename(dirname(path)) !== "concourse-v3" || !/^[a-zA-Z0-9_-]{1,64}$/.test(basename(path))) throw new Error("Use an explicit absolute concourse-v3/profile directory");
  for (let p = path; p !== dirname(p); p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error("Private path cannot contain symlinks");
  }
  if (!existsSync(path)) throw new Error("Operator must create the authorized private v3 profile first");
  const s = lstatSync(path);
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error("Private profile must be owned and mode 0700");
  return path;
}
// Walk no-follow descriptors, not recursive mkdir through mutable path components.
// Bootstrap creates only the requested new profile and its missing parent directories.
export function createProfile(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || basename(dirname(path)) !== "concourse-v3" || !/^[a-zA-Z0-9_-]{1,64}$/.test(basename(path))) throw new Error("Use an explicit absolute concourse-v3/profile directory");
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const parts = path.slice(1).split("/");
    for (let i = 0; i < parts.length; i++) {
      const child = join(`/proc/self/fd/${fd}`, parts[i]);
      if (i === parts.length - 1) { mkdirSync(child, { mode: 0o700 }); fsyncSync(fd); }
      let next: number;
      try { next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || i === parts.length - 1) throw e;
        mkdirSync(child, { mode: 0o700 }); fsyncSync(fd);
        next = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      }
      closeSync(fd); fd = next;
      if (i >= parts.length - 2) {
        const s = fstatSync(fd);
        if (s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error("Private profile parent must be owned and mode 0700");
      }
    }
    privateRoot(path);
  } finally { closeSync(fd); }
}
function safeFile(s: Stats): void {
  if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size > 4 * 1024 * 1024) throw new Error("Unsafe private file");
}
export class PrivateFiles {
  readonly root: string;
  private directory: number;
  private identity: Stats;
  private closed = false;
  private lock?: { fd: number; identity: Stats; epoch: string };
  constructor(root: string) {
    this.root = privateRoot(root);
    if (process.platform !== "linux") throw new Error("V3 private storage requires Linux kernel flock");
    this.directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    this.identity = fstatSync(this.directory);
    this.check();
  }
  private check(): void {
    if (this.closed) throw new Error("Private store closed");
    privateRoot(this.root);
    const s = lstatSync(this.root);
    if (s.dev !== this.identity.dev || s.ino !== this.identity.ino) throw new Error("Private directory replaced");
    if (this.lock) {
      const lock = lstatSync(join(`/proc/self/fd/${this.directory}`, "consumer.json")); safeFile(lock);
      if (lock.dev !== this.lock.identity.dev || lock.ino !== this.lock.identity.ino) throw new Error("Consumer lock replaced; old owner fenced");
    }
  }
  ownsConsumer(epoch?: string): boolean { try { this.check(); return !!this.lock && (epoch === undefined || this.consumerEpoch() === epoch); } catch { return false; } }
  consumerEpoch(): string {
    this.check();
    if (!this.lock) throw new Error("OAuth exchange requires the profile consumer lock");
    const owner = this.read<{ version: number; epoch: string }>("oauth-owner.json");
    if (owner?.version !== 1 || owner.epoch !== this.lock.epoch || Object.keys(owner).length !== 2) throw new Error("OAuth profile owner epoch changed");
    return this.lock.epoch;
  }
  close(): void { if (!this.closed) { if (this.lock) { closeSync(this.lock.fd); this.lock = undefined; } this.closed = true; closeSync(this.directory); } }
  read<T>(name: string): T | undefined {
    const path = this.path(name);
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    try {
      safeFile(fstatSync(fd));
      const bytes = Buffer.alloc(4 * 1024 * 1024 + 1); let size = 0;
      while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
      if (size > 4 * 1024 * 1024) throw new Error("Private file too large");
      this.check(); return JSON.parse(bytes.subarray(0, size).toString("utf8")) as T;
    } finally { closeSync(fd); }
  }
  write(name: string, value: unknown): void {
    this.read(name);
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error("Private ledger full; retain fences and reconcile offline");
    const path = this.path(name), tmp = this.path(`tmp-${randomUUID()}.json`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      safeFile(fstatSync(fd)); writeFileSync(fd, bytes); fsyncSync(fd);
      this.check(); renameSync(tmp, path); fsyncSync(this.directory);
    } finally { closeSync(fd); if (existsSync(tmp)) unlinkSync(tmp); }
  }
  acquire(): () => void {
    if (this.lock) throw new Error("V3 consumer already owned");
    const path = this.path("consumer.json");
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      safeFile(fstatSync(fd));
      // flock's fd 3 shares this open-file description. The parent keeps the kernel
      // lock until close; process death releases it. Never unlink a lock inode.
      const result = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
      if (result.error || result.status !== 0) throw new Error("V3 consumer already owned or kernel flock unavailable");
      this.check();
      this.lock = { fd, identity: fstatSync(fd), epoch: randomUUID() };
      // A durable epoch fences callbacks even after this same object reacquires
      // the same flock inode. The inode itself must never be replaced.
      this.write("oauth-owner.json", { version: 1, epoch: this.lock.epoch });
    } catch (e) { this.lock = undefined; closeSync(fd); throw e; }
    let released = false;
    return () => { if (!released) { released = true; if (this.lock?.fd === fd) { this.lock = undefined; closeSync(fd); } } };
  }
  private path(name: string): string {
    this.check();
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new Error("Invalid private filename");
    return join(`/proc/self/fd/${this.directory}`, name);
  }
}
export class FileJournal implements Journal {
  constructor(private files: PrivateFiles) {}
  load(): Ledger {
    const l = this.files.read<Ledger>("ledger.json") ?? emptyLedger();
    if (l.version !== 3 || !l.batches || !l.outgoing || !l.cursors) throw new Error("Invalid v3 ledger; no automatic reset");
    l.seenAnswers ??= {};
    return structuredClone(l);
  }
  save(value: Ledger): void { this.files.write("ledger.json", value); }
}
