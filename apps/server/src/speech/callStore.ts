// @effect-diagnostics nodeBuiltinImport:off - Atomic archive writes require file and directory fsync.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { CallOptions, CallUtterance, ThreadTurnStartCommand } from "@t3tools/contracts";
import { CallModels } from "@t3tools/contracts";
import { OperatorChat, OperatorLink } from "./operatorProtocol.ts";

const callRecord = Schema.Struct({
  ...CallOptions.fields,
  callId: Schema.String,
  createdAt: Schema.String,
  version: Schema.String,
  closed: Schema.Boolean,
  lease: Schema.optional(Schema.String),
  leaseUntil: Schema.optional(Schema.Number),
  steps: Schema.Array(Schema.String),
  recentUtterances: Schema.optional(Schema.Array(Schema.String)),
  recentPlayed: Schema.optional(Schema.Array(Schema.String)),
});
const transcriptRecord = Schema.Struct({ text: Schema.String, transcribedAt: Schema.String });
const deliveryRecord = Schema.Struct({
  messageId: Schema.String,
  preparedAt: Schema.optional(Schema.String),
  deliveredAt: Schema.optional(Schema.String),
});
const speechRecord = Schema.Struct({ text: Schema.String, at: Schema.String });
const playedRecord = Schema.Struct({ id: Schema.String, at: Schema.String });
const bindingRecord = Schema.Struct({ callId: Schema.String });

function validateRecord(name: string, value: unknown) {
  const schema = name.endsWith(".operator.json")
    ? OperatorChat
    : name.endsWith(".link.json")
      ? OperatorLink
      : name === "default.models.json"
        ? CallModels
        : name === "call.json"
          ? callRecord
          : name.endsWith(".raw.json") || name.endsWith(".upload.json")
            ? CallUtterance
            : name.endsWith(".transcript.json")
              ? transcriptRecord
              : name.endsWith(".delivery.json")
                ? deliveryRecord
                : name.endsWith(".dispatch.json")
                  ? ThreadTurnStartCommand
                  : name.endsWith(".speech.json")
                    ? speechRecord
                    : name.endsWith(".played.json")
                      ? playedRecord
                      : bindingRecord;
  if (!Schema.is(schema)(value))
    throw new Error(`Invalid saved call record: ${name}. Retain the archive for recovery.`);
  if (schema === CallUtterance) {
    const raw = value as CallUtterance;
    if (
      !/^[a-f0-9]{64}$/.test(raw.sha256) ||
      !Number.isInteger(raw.bytes) ||
      raw.bytes <= 0 ||
      raw.bytes % 2 ||
      !Number.isInteger(raw.sampleRate) ||
      raw.sampleRate < 8000 ||
      raw.sampleRate > 96000 ||
      ![raw.startedAt, raw.endedAt, raw.savedAt].every((at) => Number.isFinite(Date.parse(at)))
    )
      throw new Error(`Invalid saved call record: ${name}. Retain the archive for recovery.`);
  }
}

export interface CallRecord extends CallOptions {
  callId: string;
  createdAt: string;
  version: string;
  closed: boolean;
  lease?: string;
  leaseUntil?: number;
  steps: string[];
  recentUtterances?: string[];
  recentPlayed?: string[];
}
export const sha256 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
export function callIdentifier(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("Invalid call record ID.");
  return value;
}

/** One writer per key within the server that owns this T3 home. */
export class CallStore {
  private locks = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<() => void>>();
  readonly root: string;
  private platform: NodeJS.Platform;
  constructor(root: string, platform = HostProcessPlatform.defaultValue()) {
    this.platform = platform;
    this.root = root;
  }

  directory(callId: string) {
    return NodePath.join(this.root, callIdentifier(callId));
  }
  async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  async read<T>(callId: string, name: string): Promise<T | undefined> {
    return this.serial(`file:${callId}:${name}`, async () => {
      try {
        if (name !== name.split(/[\\/]/).pop()) throw new Error("Invalid record name.");
        const value: unknown = JSON.parse(
          await NodeFSP.readFile(NodePath.join(this.directory(callId), name), "utf8"),
        );
        validateRecord(name, value);
        return value as T;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    });
  }
  async require(callId: string): Promise<CallRecord> {
    const record = await this.read<CallRecord>(callId, "call.json");
    if (!record) throw new Error("Call not found. Start a call in this chat first.");
    if (record.callId !== callId)
      throw new Error("Saved call identity does not match its archive.");
    return record;
  }
  async write(callId: string, name: string, value: unknown) {
    validateRecord(name, value);
    await this.writeBytes(callId, name, Buffer.from(JSON.stringify(value)));
  }
  async writeBytes(callId: string, name: string, bytes: Uint8Array) {
    if (name !== name.split(/[\\/]/).pop()) throw new Error("Invalid record name.");
    return this.serial(`file:${callId}:${name}`, async () => {
      const directory = this.directory(callId);
      await NodeFSP.mkdir(directory, { recursive: true });
      const target = NodePath.join(directory, name);
      const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
      const file = await NodeFSP.open(temporary, "wx");
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await NodeFSP.rename(temporary, target);
      // Windows does not support opening directories for fsync. File data is flushed
      // before rename; POSIX additionally flushes the directory entry.
      if (this.platform !== "win32") {
        const parent = await NodeFSP.open(directory, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    });
  }
  async records<T>(callId: string, suffix: string): Promise<T[]> {
    const names = (await NodeFSP.readdir(this.directory(callId)))
      .filter((name) => name.endsWith(suffix))
      .sort();
    return Promise.all(names.map(async (name) => (await this.read<T>(callId, name))!));
  }
  async activeCall(threadId: string, except: string) {
    await NodeFSP.mkdir(this.root, { recursive: true });
    for (const entry of await NodeFSP.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "_threads" || entry.name === except) continue;
      const record = await this.read<CallRecord>(entry.name, "call.json");
      if (record?.threadId === threadId && !record.closed) return record;
    }
  }
  /** Called under the thread lock; closing an old archive cannot unbind a newer call. */
  async unbind(threadId: string, callId: string) {
    const name = `${sha256(threadId)}.json`;
    if ((await this.read<{ callId: string }>("_threads", name))?.callId === callId)
      await NodeFSP.rm(NodePath.join(this.directory("_threads"), name), { force: true });
  }
  async changed(record: CallRecord) {
    record.version = NodeCrypto.randomUUID();
    await this.write(record.callId, "call.json", record);
    for (const listener of this.listeners.get(record.callId) ?? []) listener();
  }
  async wait(callId: string, version: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    let wake!: () => void;
    const changed = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const listeners = this.listeners.get(callId) ?? new Set<() => void>();
    listeners.add(wake);
    this.listeners.set(callId, listeners);
    signal.addEventListener("abort", wake, { once: true });
    const keepalive = Effect.runFork(Effect.delay(Effect.sync(wake), "25 seconds"));
    try {
      if ((await this.require(callId)).version === version) await changed;
    } finally {
      Effect.runFork(Fiber.interrupt(keepalive));
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
  const root = NodePath.resolve(stateDir, "voice", "calls");
  let store = stores.get(root);
  if (!store) {
    store = new CallStore(root);
    stores.set(root, store);
  }
  return store;
}
