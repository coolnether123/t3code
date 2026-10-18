import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CallOptions, CallConfirmation, CallUtterance } from "@t3tools/contracts";

export interface CallRecord extends CallOptions {
  callId: string;
  createdAt: string;
  version: string;
  closed: boolean;
  lease?: string;
  leaseUntil?: number;
  steps: string[];
}
export interface StoredConfirmation extends CallConfirmation {
  inputHash: string;
  decision?: "yes" | "no";
}
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function callIdentifier(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid call record ID.");
  return value;
}

/** One writer per key within the server that owns this T3 home. */
export class CallStore {
  private locks = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<() => void>>();
  constructor(readonly root: string) {}

  directory(callId: string) { return join(this.root, callIdentifier(callId)); }
  async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(key, next);
    try { return await next; }
    finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  async read<T>(callId: string, name: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(join(this.directory(callId), name), "utf8")) as T; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async require(callId: string): Promise<CallRecord> {
    const record = await this.read<CallRecord>(callId, "call.json");
    if (!record) throw new Error("Call not found. Start a call in this chat first.");
    return record;
  }
  async write(callId: string, name: string, value: unknown) {
    await this.writeBytes(callId, name, Buffer.from(JSON.stringify(value)));
  }
  async writeBytes(callId: string, name: string, bytes: Uint8Array) {
    const directory = this.directory(callId);
    await mkdir(directory, { recursive: true });
    const target = join(directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx");
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    // Windows does not support opening directories for fsync. File data is flushed
    // before rename; POSIX additionally flushes the directory entry.
    if (process.platform !== "win32") {
      const parent = await open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
  }
  async records<T>(callId: string, suffix: string): Promise<T[]> {
    const names = (await readdir(this.directory(callId))).filter((name) => name.endsWith(suffix)).sort();
    return Promise.all(names.map(async (name) => (await this.read<T>(callId, name))!));
  }
  async changed(record: CallRecord) {
    record.version = randomUUID();
    await this.write(record.callId, "call.json", record);
    for (const listener of this.listeners.get(record.callId) ?? []) listener();
  }
  async wait(callId: string, version: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    let wake!: () => void;
    const changed = new Promise<void>((resolve) => { wake = resolve; });
    const listeners = this.listeners.get(callId) ?? new Set<() => void>();
    listeners.add(wake);
    this.listeners.set(callId, listeners);
    signal.addEventListener("abort", wake, { once: true });
    const keepalive = setTimeout(wake, 25_000);
    try { if ((await this.require(callId)).version === version) await changed; }
    finally {
      clearTimeout(keepalive);
      signal.removeEventListener("abort", wake);
      listeners.delete(wake);
      if (!listeners.size) this.listeners.delete(callId);
    }
    signal.throwIfAborted();
  }
  async utterance(callId: string, id: string): Promise<CallUtterance> {
    const raw = await this.read<CallUtterance>(callId, `${callIdentifier(id)}.raw.json`);
    if (!raw) throw new Error("Upload and acknowledge raw audio before transcribing.");
    const transcript = await this.read<Partial<CallUtterance>>(callId, `${id}.transcript.json`);
    const delivery = await this.read<Partial<CallUtterance>>(callId, `${id}.delivery.json`);
    return { ...raw, ...transcript, ...delivery };
  }
}
const stores = new Map<string, CallStore>();
export function callStore(stateDir: string) {
  const root = resolve(stateDir, "voice", "calls");
  let store = stores.get(root);
  if (!store) { store = new CallStore(root); stores.set(root, store); }
  return store;
}
