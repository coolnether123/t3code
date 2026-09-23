// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and `readline` over a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  initialGeminiScanState,
  mightCarryUsage,
  parseAntigravityTokenCache,
  parseClaudeLine,
  parseCodexLine,
  parseGeminiLine,
  parseGeminiValue,
  parseOpenCodeMessageValue,
  type CodexScanState,
  type UsageRecord,
} from "./usageTranscripts.ts";
import { parseAiStudioExport, parseChatGptExport } from "./usageImportedChats.ts";
import {
  initialRepeatedInputParserState,
  parseCodexRepeatedInputLineDetailed,
  type ParseCodexRepeatedInputOptions,
  type RepeatedInputCatalog,
  type RepeatedInputObservation,
  type RepeatedInputParserState,
  type RepeatedInputTokenizer,
} from "./usageRepeatedInput.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TranscriptFileListing {
  readonly files: readonly TranscriptFile[];
  /** False when the bounded directory walk stopped before it saw every entry. */
  readonly complete: boolean;
}

interface TranscriptInventoryWalk {
  running: boolean;
  readonly directories: string[];
  directoryOffset: number;
  readonly transcripts: string[];
  transcriptOffset: number;
  readonly files: Map<string, TranscriptFile>;
}

const pendingTranscriptInventories = new Map<string, TranscriptInventoryWalk>();

export interface TranscriptScanSelection<File extends TranscriptFile = TranscriptFile> {
  readonly files: readonly File[];
  readonly deferredFiles: number;
  readonly deferredBytes: number;
  readonly coldBytes: number;
}

/**
 * Chooses newest transcripts first while bounding uncached I/O for one request.
 * Warm files cost zero and validated append reads cost only their new bytes.
 * This allows repeated reads to progressively
 * fill the cache without making the usage page wait on an unbounded cold scan.
 */
export function selectTranscriptFilesForScan<File extends TranscriptFile>(
  files: readonly File[],
  bytesToRead: (file: File) => number,
  maxColdBytes: number,
): TranscriptScanSelection<File> {
  const selected: File[] = [];
  let deferredFiles = 0;
  let deferredBytes = 0;
  let coldBytes = 0;
  const oversized: File[] = [];
  let selectedColdFile = false;

  const newestFirst = [...files].sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
  );
  for (const file of newestFirst) {
    const readBytes = bytesToRead(file);
    if (readBytes === 0) {
      selected.push(file);
      continue;
    }
    if (readBytes <= maxColdBytes - coldBytes) {
      selected.push(file);
      coldBytes += readBytes;
      if (readBytes === file.size && readBytes > 0) selectedColdFile = true;
      continue;
    }
    oversized.push(file);
    deferredFiles += 1;
    deferredBytes += readBytes;
  }

  // A single giant rollout must make progress eventually, but it should not
  // block the first useful result while smaller cold files can fill the
  // bounded batch. Warm files and append-only active rollouts do not provide
  // that first-load protection, so admit one oversized file alongside them
  // and keep the partial totals visible while it is parsed.
  if (!selectedColdFile && oversized.length > 0) {
    const file = oversized[0]!;
    const readBytes = bytesToRead(file);
    selected.push(file);
    coldBytes += readBytes;
    deferredFiles -= 1;
    deferredBytes -= readBytes;
  }

  return { files: selected, deferredFiles, deferredBytes, coldBytes };
}

/**
 * Lists provider transcript files under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  provider: UsageProviderKind,
): Promise<readonly TranscriptFile[]> {
  return (await listTranscriptFilesBounded(root, sinceMs, provider, Number.POSITIVE_INFINITY))
    .files;
}

/**
 * Lists recent transcript files without letting directory metadata consume an
 * entire RPC deadline. Callers must surface an incomplete listing as partial.
 */
export async function listTranscriptFilesBounded(
  root: string,
  sinceMs: number,
  provider: UsageProviderKind,
  maxDurationMs: number,
  now: () => number = () => performance.now(),
): Promise<TranscriptFileListing> {
  if (provider === "opencode") {
    return { files: await listOpenCodeDatabase(root, sinceMs), complete: true };
  }

  const inventoryKey = `${provider}\u0000${root}`;
  const inventory = pendingTranscriptInventories.get(inventoryKey) ?? {
    running: false,
    directories: [root],
    directoryOffset: 0,
    transcripts: [],
    transcriptOffset: 0,
    files: new Map<string, TranscriptFile>(),
  };
  pendingTranscriptInventories.set(inventoryKey, inventory);
  const deadline = now() + maxDurationMs;
  const expired = () => now() >= deadline;
  const partial = (): TranscriptFileListing => ({
    files: [...inventory.files.values()].filter((file) => file.mtimeMs >= sinceMs),
    complete: false,
  });
  // Effect cancellation does not stop an already-started native filesystem promise.
  if (inventory.running) return partial();
  inventory.running = true;
  try {
    const isTranscript = (name: string) =>
      provider === "aistudio"
        ? true
        : provider === "chatgpt"
          ? name === "conversations.json"
          : provider === "gemini"
            ? (name.startsWith("session-") &&
                (name.endsWith(".json") || name.endsWith(".jsonl"))) ||
              name === "tokens_cache.json"
            : name.endsWith(".jsonl");

    // The provider homes contain thousands of nested directories. Walking one
    // directory at a time made a warm refresh spend tens of seconds on metadata.
    // Breadth-first batches keep I/O bounded while allowing independent folders
    // to resolve together.
    while (true) {
      if (expired()) return partial();
      // Stat as soon as discovery finds a batch. Returning a timed partial
      // inventory therefore carries useful files forward instead of repeating a
      // long directory-only pass on the next request.
      if (inventory.transcriptOffset < inventory.transcripts.length) {
        const paths = inventory.transcripts.slice(
          inventory.transcriptOffset,
          inventory.transcriptOffset + 128,
        );
        inventory.transcriptOffset += paths.length;
        const batch = await Promise.all(
          paths.map(async (child) => {
            try {
              const stats = await NodeFSP.stat(child);
              return { path: child, size: stats.size, mtimeMs: stats.mtimeMs };
            } catch {
              return null;
            }
          }),
        );
        for (const file of batch) {
          if (file !== null) inventory.files.set(file.path, file);
        }
        if (expired()) return partial();
        continue;
      }
      if (inventory.directoryOffset < inventory.directories.length) {
        const directories = inventory.directories.slice(
          inventory.directoryOffset,
          inventory.directoryOffset + 64,
        );
        inventory.directoryOffset += directories.length;
        const listings = await Promise.all(
          directories.map(async (dir) => {
            try {
              return { dir, entries: await NodeFSP.readdir(dir, { withFileTypes: true }) };
            } catch {
              return { dir, entries: [] };
            }
          }),
        );
        for (const { dir, entries } of listings) {
          for (const entry of entries) {
            const child = NodePath.join(dir, entry.name);
            if (entry.isDirectory()) inventory.directories.push(child);
            else if (isTranscript(entry.name)) inventory.transcripts.push(child);
          }
        }
        if (expired()) return partial();
        continue;
      }
      if (pendingTranscriptInventories.get(inventoryKey) === inventory) {
        pendingTranscriptInventories.delete(inventoryKey);
      }
      return {
        files: [...inventory.files.values()].filter((file) => file.mtimeMs >= sinceMs),
        complete: true,
      };
    }
  } finally {
    inventory.running = false;
  }
}

/**
 * Returns OpenCode's SQLite store as one cacheable source.
 *
 * SQLite may leave new commits in the WAL while the main database file stays
 * unchanged. Folding the sidecars into the synthetic size/mtime identity makes
 * a newly appended assistant response invalidate only this source's cache.
 */
async function listOpenCodeDatabase(
  root: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[]> {
  const databasePath = NodePath.join(root, "opencode.db");
  let size = 0;
  let mtimeMs = 0;
  let foundDatabase = false;
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      const stats = await NodeFSP.stat(path);
      size += stats.size;
      mtimeMs = Math.max(mtimeMs, stats.mtimeMs);
      if (path === databasePath) foundDatabase = true;
    } catch {
      // SQLite sidecars are optional and disappear after checkpoints.
    }
  }
  return foundDatabase && mtimeMs >= sinceMs ? [{ path: databasePath, size, mtimeMs }] : [];
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export interface TranscriptReadOptions {
  readonly startByte?: number;
  readonly endByte?: number;
  /** Source length when `endByte` is a bounded chunk rather than EOF. */
  readonly sourceSize?: number;
  /** Continue discarding one oversized JSONL line until its terminating newline. */
  readonly discardPartialLine?: boolean;
  readonly codexState?: CodexScanState;
}

export interface TranscriptReadResult {
  readonly records: readonly UsageRecord[];
  /** First byte not folded into `records` or parser state. Always follows a newline unless EOF. */
  readonly nextByte: number;
  /** Oversized complete records omitted under the bounded-memory policy. */
  readonly discardedLines: number;
  /** `nextByte` remains inside an oversized record and is not a parser cursor. */
  readonly discardingLine: boolean;
  readonly codexState?: CodexScanState;
}

export interface RepeatedInputReadOptions extends Omit<
  ParseCodexRepeatedInputOptions,
  "project" | "environment"
> {
  readonly startByte?: number | undefined;
  readonly endByte?: number | undefined;
  readonly parserState?: RepeatedInputParserState | undefined;
  readonly project?: string | null | undefined;
  readonly environment?: string | null | undefined;
}

export interface RepeatedInputReadResult {
  readonly observations: readonly RepeatedInputObservation[];
  readonly gaps: readonly import("@t3tools/contracts").UsageRepeatedInputCoverageGap[];
  readonly parserState: RepeatedInputParserState;
}

/** Whether an append cursor follows a complete JSONL record. */
export async function transcriptCursorIsLineBoundary(
  filePath: string,
  offset: number,
): Promise<boolean> {
  if (offset === 0) return true;
  let file: NodeFSP.FileHandle | null = null;
  try {
    file = await NodeFSP.open(filePath, "r");
    const byte = Buffer.allocUnsafe(1);
    const read = await file.read(byte, 0, 1, offset - 1);
    return read.bytesRead === 1 && byte[0] === 0x0a;
  } catch {
    return false;
  } finally {
    await file?.close();
  }
}

/**
 * Visits only complete JSONL records in a byte range and returns the first
 * unread byte. A bounded read never feeds a torn final line to a reducer, so
 * its returned cursor can safely carry parser state into the next request.
 */
const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;

interface JsonlReadProgress {
  readonly nextByte: number;
  readonly discardedLines: number;
  readonly discardingLine: boolean;
}

async function readCompleteJsonlLines(
  filePath: string,
  options: Pick<
    TranscriptReadOptions,
    "startByte" | "endByte" | "sourceSize" | "discardPartialLine"
  >,
  visit: (line: string) => void,
): Promise<JsonlReadProgress> {
  const start = options.startByte ?? 0;
  const end = options.endByte;
  if (end !== undefined && end < start) {
    return { nextByte: start, discardedLines: 0, discardingLine: false };
  }

  let nextByte = start;
  let pending = Buffer.alloc(0);
  let discardedLines = 0;
  let discardingLine = options.discardPartialLine === true;
  const discardUntilLineEnd = (bytes: Buffer): Buffer => {
    const lineEnd = bytes.indexOf(0x0a);
    if (lineEnd < 0) {
      nextByte += bytes.length;
      return Buffer.alloc(0);
    }
    nextByte += lineEnd + 1;
    discardedLines += 1;
    discardingLine = false;
    return bytes.subarray(lineEnd + 1);
  };
  const input = NodeFS.createReadStream(filePath, {
    ...(start === 0 ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  });
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = discardingLine ? discardUntilLineEnd(bytes) : bytes;
    if (discardingLine) continue;
    pending = pending.length === 0 ? remaining : Buffer.concat([pending, remaining]);
    let lineEnd = pending.indexOf(0x0a);
    while (lineEnd >= 0) {
      const hasCarriageReturn = lineEnd > 0 && pending[lineEnd - 1] === 0x0d;
      visit(pending.subarray(0, hasCarriageReturn ? lineEnd - 1 : lineEnd).toString("utf8"));
      nextByte += lineEnd + 1;
      pending = pending.subarray(lineEnd + 1);
      lineEnd = pending.indexOf(0x0a);
    }
    if (pending.length > MAX_JSONL_LINE_BYTES) {
      // Retaining an arbitrary JSON value only to find its newline would make
      // the response memory-unbounded. Skip it in fixed-size chunks instead,
      // and preserve partial source coverage for the omitted record.
      discardingLine = true;
      nextByte += pending.length;
      pending = Buffer.alloc(0);
    }
  }

  // JSONL producers occasionally omit the final newline. It is safe to parse
  // that final record only when this range reaches the known end of the file.
  const reachesEnd =
    end === undefined || options.sourceSize === undefined || end >= options.sourceSize - 1;
  if (discardingLine && reachesEnd) {
    discardedLines += 1;
    discardingLine = false;
  } else if (pending.length > 0 && reachesEnd) {
    const hasCarriageReturn = pending[pending.length - 1] === 0x0d;
    visit(
      pending.subarray(0, hasCarriageReturn ? pending.length - 1 : pending.length).toString("utf8"),
    );
    nextByte += pending.length;
  }
  return { nextByte, discardedLines, discardingLine };
}

export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
  options: TranscriptReadOptions = {},
): Promise<TranscriptReadResult | null> {
  if (provider === "aistudio" || provider === "chatgpt") {
    const records = await readImportedChatRecords(filePath, provider);
    return records === null
      ? null
      : {
          records,
          nextByte: options.sourceSize ?? (options.endByte ?? -1) + 1,
          discardedLines: 0,
          discardingLine: false,
        };
  }
  if (provider === "gemini") {
    const records = await readGeminiTranscriptRecords(filePath);
    return records === null
      ? null
      : {
          records,
          nextByte: options.sourceSize ?? (options.endByte ?? -1) + 1,
          discardedLines: 0,
          discardingLine: false,
        };
  }
  if (provider === "opencode") {
    const records = await readOpenCodeDatabaseRecords(filePath);
    return records === null
      ? null
      : {
          records,
          nextByte: options.sourceSize ?? (options.endByte ?? -1) + 1,
          discardedLines: 0,
          discardingLine: false,
        };
  }

  const records: UsageRecord[] = [];
  const codexState = options.codexState ? { ...options.codexState } : initialCodexScanState();

  try {
    const start = options.startByte ?? 0;
    const end = options.endByte;
    if (end !== undefined && end < start) {
      return provider === "codex"
        ? { records, nextByte: start, discardedLines: 0, discardingLine: false, codexState }
        : { records, nextByte: start, discardedLines: 0, discardingLine: false };
    }
    const progress = await readCompleteJsonlLines(filePath, options, (line) => {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          return;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        return;
      }

      if (!mightCarryUsage(line, provider)) return;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    });
    return provider === "codex" ? { records, ...progress, codexState } : { records, ...progress };
  } catch {
    return null;
  }
}

/**
 * Streams Codex input evidence without returning transcript text. The cursor
 * arguments mirror `readTranscriptRecords`, so the caller can feed only an
 * append after validating the cached prefix fingerprint.
 */
export async function readRepeatedInputRecords(
  filePath: string,
  options: RepeatedInputReadOptions = {},
): Promise<RepeatedInputReadResult | null> {
  const parserState = options.parserState
    ? { ...options.parserState }
    : initialRepeatedInputParserState({
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
  const observations: RepeatedInputObservation[] = [];
  const gaps: import("@t3tools/contracts").UsageRepeatedInputCoverageGap[] = [];
  const start = options.startByte ?? 0;
  const end = options.endByte;
  if (end !== undefined && end < start) return { observations, gaps, parserState };

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, {
        encoding: "utf8",
        ...(start === 0 ? {} : { start }),
        ...(end === undefined ? {} : { end }),
      }),
      crlfDelay: Infinity,
    });
    const parseOptions: ParseCodexRepeatedInputOptions = {
      ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
      ...(options.tokenizer === undefined ? {} : { tokenizer: options.tokenizer }),
      ...(options.maxPayloadBytes === undefined
        ? {}
        : { maxPayloadBytes: options.maxPayloadBytes }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    };
    for await (const line of lines) {
      const parsed = parseCodexRepeatedInputLineDetailed(line, parserState, parseOptions);
      observations.push(...parsed.observations);
      gaps.push(...parsed.gaps);
    }
  } catch {
    gaps.push({
      reason: "unavailable",
      count: 1,
      message: "The Codex transcript could not be read.",
    });
    return { observations, gaps, parserState };
  }
  return { observations, gaps, parserState };
}

export const readCodexRepeatedInputRecords = readRepeatedInputRecords;

/** SHA-256 of the exact UTF-8 prefix used to validate append-only reads. */
export async function readTranscriptPrefixFingerprint(
  filePath: string,
  prefixLength: number,
): Promise<string | null> {
  if (!Number.isSafeInteger(prefixLength) || prefixLength < 0) return null;
  if (prefixLength === 0) return NodeCrypto.createHash("sha256").digest("hex");
  try {
    const hash = NodeCrypto.createHash("sha256");
    const stream = NodeFS.createReadStream(filePath, { start: 0, end: prefixLength - 1 });
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += buffer.byteLength;
      hash.update(buffer);
    }
    return bytes === prefixLength ? hash.digest("hex") : null;
  } catch {
    return null;
  }
}

export interface TranscriptAppendCursor {
  readonly offset: number;
  readonly prefixFingerprint: string;
}

/** Checks both JSONL boundary and byte-prefix identity before an append read. */
export async function transcriptAppendIsSafe(
  filePath: string,
  cursor: TranscriptAppendCursor,
): Promise<boolean> {
  if (cursor.offset <= 0 || !(await transcriptCursorIsLineBoundary(filePath, cursor.offset))) {
    return cursor.offset === 0;
  }
  const fingerprint = await readTranscriptPrefixFingerprint(filePath, cursor.offset);
  return fingerprint !== null && fingerprint === cursor.prefixFingerprint;
}

/** Reads one already-local product export; raw chat text never leaves the server. */
async function readImportedChatRecords(
  filePath: string,
  provider: "aistudio" | "chatgpt",
): Promise<readonly UsageRecord[] | null> {
  try {
    const raw = await NodeFSP.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const stats = await NodeFSP.stat(filePath);
    if (provider === "chatgpt") {
      return parseChatGptExport(parsed, { importedAtMs: stats.mtimeMs });
    }
    const conversationId = NodeCrypto.createHash("sha256").update(raw).digest("hex");
    return parseAiStudioExport(parsed, { conversationId, importedAtMs: stats.mtimeMs });
  } catch {
    return null;
  }
}

interface OpenCodeMessageRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly time_created: unknown;
  readonly data: unknown;
}

/** Reads usage-only assistant metadata without touching prompts or credentials. */
async function readOpenCodeDatabaseRecords(
  filePath: string,
): Promise<readonly UsageRecord[] | null> {
  let database: NodeSqlite.DatabaseSync | null = null;
  try {
    database = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
    const rows = database
      .prepare(
        "SELECT id, session_id, time_created, data FROM message WHERE json_extract(data, '$.role') = 'assistant'",
      )
      .all() as unknown as readonly OpenCodeMessageRow[];
    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        typeof row.session_id !== "string" ||
        typeof row.time_created !== "number" ||
        typeof row.data !== "string"
      ) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.data) as unknown;
      } catch {
        continue;
      }
      const record = parseOpenCodeMessageValue(parsed, {
        id: row.id,
        sessionId: row.session_id,
        timestampMs: row.time_created,
      });
      if (record !== null) records.push(record);
    }
    return records;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

async function readGeminiTranscriptRecords(
  filePath: string,
): Promise<readonly UsageRecord[] | null> {
  const state = initialGeminiScanState();
  const byMessage = new Map<string, UsageRecord>();
  const withoutIdentity: UsageRecord[] = [];
  const keep = (record: UsageRecord | null) => {
    if (record === null) return;
    if (record.dedupeKey === null) withoutIdentity.push(record);
    else byMessage.set(record.dedupeKey, record);
  };

  try {
    if (NodePath.basename(filePath) === "tokens_cache.json") {
      const parsed = JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as unknown;
      const stats = await NodeFSP.stat(filePath);
      keep(
        parseAntigravityTokenCache(parsed, {
          timestampMs: stats.mtimeMs,
          sessionId: NodePath.basename(
            NodePath.dirname(NodePath.dirname(NodePath.dirname(filePath))),
          ),
        }),
      );
      return [...byMessage.values(), ...withoutIdentity];
    }

    if (filePath.endsWith(".json")) {
      const parsed = JSON.parse(await NodeFSP.readFile(filePath, "utf8")) as unknown;
      keep(parseGeminiValue(parsed, state));
      if (typeof parsed === "object" && parsed !== null) {
        const messages = (parsed as Record<string, unknown>)["messages"];
        if (Array.isArray(messages)) {
          for (const message of messages) keep(parseGeminiValue(message, state));
        }
      }
      return [...byMessage.values(), ...withoutIdentity];
    }

    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!mightCarryUsage(line, "gemini") && !line.includes('"sessionId"')) continue;
      // JSONL session files write metadata and messages as standalone records.
      // `$set` patch records repeat message arrays and must not be counted too.
      if (line.includes('"$set"')) continue;
      keep(parseGeminiLine(line, state));
    }
    return [...byMessage.values(), ...withoutIdentity];
  } catch {
    return null;
  }
}
