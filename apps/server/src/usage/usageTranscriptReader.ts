// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and buffer-level streaming is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * Transcripts are append-only, so a parse also reports the byte position it
 * stopped at. A later scan of the same file resumes from that position and
 * parses only the appended bytes, which is what keeps a warm scan cheap while a
 * session is actively writing a multi-hundred-megabyte rollout.
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
  initialGeminiScanState,
  parseAntigravityTokenCache,
  parseGeminiLine,
  parseGeminiValue,
  parseOpenCodeMessageValue,
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  type CodexScanState,
  type UsageRecord,
} from "./usageTranscripts.ts";

import { parseAiStudioExport, parseChatGptExport } from "./usageImportedChats.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

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
    if (readBytes <= maxColdBytes - coldBytes || !selectedColdFile) {
      selected.push(file);
      coldBytes += readBytes;
      selectedColdFile = true;
      continue;
    }
    deferredFiles += 1;
    deferredBytes += readBytes;
  }

  return { files: selected, deferredFiles, deferredBytes, coldBytes };
}

/**
 * Where a parse stopped, with enough state to continue from there.
 *
 * The guard hash fingerprints the bytes immediately before `resumeOffset`. A
 * resume only proceeds when those bytes still match: transcripts are
 * append-only by design, but a rotated or rewritten file silently mis-parsed
 * from the middle would corrupt usage totals. The window is a cheap tripwire
 * for those realistic failure shapes, all of which disturb the file's tail at
 * that exact offset; it deliberately does not hash the whole prefix, which
 * would cost the full re-read the resume exists to avoid.
 */
export interface TranscriptParsePosition {
  /** Byte offset just past the last newline-terminated line consumed. */
  readonly resumeOffset: number;
  /** Length of the fingerprinted window ending at `resumeOffset`. */
  readonly guardLength: number;
  /** FNV-1a hash of that window. */
  readonly guardHash: number;
  /** Codex reducer state as of `resumeOffset`; `null` for stateless providers. */
  readonly codexState: CodexScanState | null;
}

export interface TranscriptParseResult {
  /** Records from newline-terminated lines at or after the parse start. */
  readonly records: readonly UsageRecord[];
  /**
   * Records from a trailing segment the writer has not newline-terminated yet.
   * Kept out of `records` because `position` deliberately excludes that
   * segment: the next scan re-reads it once the writer finishes the line.
   */
  readonly tailRecords: readonly UsageRecord[];
  readonly position: TranscriptParsePosition;
  /** Whether the parse continued from `resumeFrom` rather than byte 0. */
  readonly resumed: boolean;
}

/** 64 bytes of JSONL tail is ample to distinguish a replaced file. */
export const GUARD_LENGTH = 64;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < buffer.length; index += 1) {
    hash ^= buffer[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 *
 * `fileName` restricts the walk to a single basename (Grok's `updates.jsonl`).
 * Grok sessions also ship multi-megabyte `chat_history` and `events` logs that
 * never carry usage, so the basename filter keeps a cold scan off those files.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  providerOrOptions: UsageProviderKind | { readonly fileName?: string } = "codex",
): Promise<readonly TranscriptFile[]> {
  const provider = typeof providerOrOptions === "string" ? providerOrOptions : "codex";
  const fileName =
    typeof providerOrOptions === "string"
      ? provider === "grok"
        ? "updates.jsonl"
        : undefined
      : providerOrOptions.fileName;
  if (provider === "opencode") return listOpenCodeDatabase(root, sinceMs);

  const found: TranscriptFile[] = [];
  const directories = [root];
  const transcripts: string[] = [];

  // The provider homes contain thousands of nested directories. Walking one
  // directory at a time made a warm refresh spend tens of seconds on metadata.
  // Breadth-first batches keep I/O bounded while allowing independent folders
  // to resolve together.
  for (let offset = 0; offset < directories.length;) {
    const batch = directories.slice(offset, offset + 64);
    offset += batch.length;
    const listings = await Promise.all(
      batch.map(async (dir) => {
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
        if (entry.isDirectory()) {
          directories.push(child);
          continue;
        }
        const isTranscript =
          fileName !== undefined
            ? entry.name === fileName
            : provider === "aistudio"
              ? true
              : provider === "chatgpt"
                ? entry.name === "conversations.json"
                : provider === "gemini"
                  ? (entry.name.startsWith("session-") &&
                      (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))) ||
                    entry.name === "tokens_cache.json"
                  : entry.name.endsWith(".jsonl");
        if (isTranscript) transcripts.push(child);
      }
    }
  }

  // Bound concurrent metadata reads, including on slower network-backed homes.
  for (let offset = 0; offset < transcripts.length; offset += 128) {
    const batch = await Promise.all(
      transcripts.slice(offset, offset + 128).map(async (child) => {
        try {
          const stats = await NodeFSP.stat(child);
          return stats.mtimeMs >= sinceMs
            ? { path: child, size: stats.size, mtimeMs: stats.mtimeMs }
            : null;
        } catch {
          return null;
        }
      }),
    );
    for (const file of batch) {
      if (file !== null) found.push(file);
    }
  }

  return found;
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

async function guardMatches(
  handle: NodeFSP.FileHandle,
  position: TranscriptParsePosition,
): Promise<boolean> {
  if (position.guardLength <= 0 || position.guardLength > GUARD_LENGTH) return false;
  try {
    const window = Buffer.alloc(position.guardLength);
    const { bytesRead } = await handle.read(
      window,
      0,
      position.guardLength,
      position.resumeOffset - position.guardLength,
    );
    return bytesRead === position.guardLength && fnv1a(window) === position.guardHash;
  } catch {
    return false;
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
 * With `resumeFrom`, parsing continues from that position when its guard bytes
 * still match, so only appended lines are read; otherwise the whole file is
 * re-parsed from the start and `resumed` reports `false`.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
  resumeFrom?: TranscriptParsePosition,
): Promise<TranscriptParseResult | null> {
  if (
    provider === "aistudio" ||
    provider === "chatgpt" ||
    provider === "gemini" ||
    provider === "opencode"
  ) {
    const records =
      provider === "gemini"
        ? await readGeminiTranscriptRecords(filePath)
        : provider === "opencode"
          ? await readOpenCodeDatabaseRecords(filePath)
          : await readImportedChatRecords(filePath, provider);
    return records === null
      ? null
      : {
          records,
          tailRecords: [],
          position: { resumeOffset: 0, guardLength: 0, guardHash: 0, codexState: null },
          resumed: false,
        };
  }
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }

  try {
    let codexState = initialCodexScanState();
    let resumed = false;
    let start = 0;
    if (
      resumeFrom !== undefined &&
      resumeFrom.resumeOffset > 0 &&
      (provider !== "codex" || resumeFrom.codexState !== null) &&
      (await guardMatches(handle, resumeFrom))
    ) {
      if (resumeFrom.codexState !== null) codexState = { ...resumeFrom.codexState };
      start = resumeFrom.resumeOffset;
      resumed = true;
    }

    const parseLine = (line: string, state: CodexScanState, out: UsageRecord[]): void => {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          return;
        }
        const record = parseCodexLine(line, state);
        if (record !== null) out.push(record);
        return;
      }
      if (!mightCarryUsage(line, provider)) return;
      if (provider === "grok") {
        for (const grokRecord of parseGrokLine(line)) out.push(grokRecord);
        return;
      }
      const record = parseClaudeLine(line);
      if (record !== null) out.push(record);
    };

    const toLineString = (lineBuffer: Buffer): string => {
      const content =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === CARRIAGE_RETURN
          ? lineBuffer.subarray(0, -1)
          : lineBuffer;
      return content.toString("utf8");
    };

    const records: UsageRecord[] = [];
    // Buffer-level line splitting rather than `readline`, because resuming
    // needs byte-exact offsets and decoded strings cannot provide them.
    // Newline-free chunks are collected rather than concatenated as they
    // arrive, so a single huge line costs one copy instead of one per chunk.
    let resumeOffset = start;
    let pendingChunks: Buffer[] = [];
    const stream = handle.createReadStream({
      start,
      autoClose: false,
    }) as AsyncIterable<Buffer>;
    for await (const chunk of stream) {
      if (!chunk.includes(NEWLINE)) {
        pendingChunks.push(chunk);
        continue;
      }
      const buffer: Buffer =
        pendingChunks.length === 0 ? chunk : Buffer.concat([...pendingChunks, chunk]);
      pendingChunks = [];
      let lineStart = 0;
      for (;;) {
        const newlineIndex = buffer.indexOf(NEWLINE, lineStart);
        if (newlineIndex === -1) break;
        parseLine(toLineString(buffer.subarray(lineStart, newlineIndex)), codexState, records);
        lineStart = newlineIndex + 1;
      }
      resumeOffset += lineStart;
      if (lineStart < buffer.length) pendingChunks.push(buffer.subarray(lineStart));
    }

    // A trailing segment without its newline is parsed for this result but not
    // consumed: a writer may still be appending to it, and counting a half
    // record now and its full form later would double count.
    const tailRecords: UsageRecord[] = [];
    if (pendingChunks.length > 0) {
      const pending = pendingChunks.length === 1 ? pendingChunks[0]! : Buffer.concat(pendingChunks);
      if (pending.length > 0) parseLine(toLineString(pending), { ...codexState }, tailRecords);
    }

    const guardLength = Math.min(GUARD_LENGTH, resumeOffset);
    let guardHash = 0;
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, resumeOffset - guardLength);
      guardHash = fnv1a(window);
    }

    return {
      records,
      tailRecords,
      position: {
        resumeOffset,
        guardLength,
        guardHash,
        codexState: provider === "codex" ? codexState : null,
      },
      resumed,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
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
