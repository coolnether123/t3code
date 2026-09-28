// @effect-diagnostics nodeBuiltinImport:off
/**
 * Durable, incrementally written transcript scan cache.
 *
 * Only a small index stays in memory: each transcript's size, mtime, cursor
 * state, and latest timestamp. Parsed records live in SQLite and are decoded
 * when a scan needs that file, behind a bounded decode cache, so retained
 * usage history no longer grows the server heap.
 *
 * Each file has one head row (cursor, parser state, repeated-input data) and
 * append-only record chunks. A transcript that grew writes only its new
 * records; a re-parsed one replaces its chunks. Rows use the positional format
 * `usageScanCache` already validates, so a corrupt row costs one re-parse of
 * that transcript, never a broken usage read.
 *
 * @module usageScanStore
 */
import * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  cachedFileMeta,
  decodeCachedFile,
  encodeCachedFile,
  type CachedFile,
  type CachedFileMeta,
  type ScanCoverage,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

/** Bump when the table layout changes; an older layout is dropped and rebuilt. */
const STORE_SCHEMA_VERSION = "2";
/** Roughly 100 MB of decoded records at the observed 3x text-to-heap ratio. */
const DEFAULT_DECODED_CACHE_CHARS = 32 * 1024 * 1024;
/** Beyond this many appends a file's chunks are rewritten as one. */
const MAX_CHUNKS_PER_FILE = 32;

const PROVIDERS: ReadonlySet<string> = new Set<UsageProviderKind>([
  "claude",
  "codex",
  "gemini",
  "opencode",
  "chatgpt",
  "aistudio",
]);

/** Identifies the last stored record so a longer record list can be recognised as an append. */
const recordSignature = (record: UsageRecord): string =>
  `${record.timestampMs}\u0000${record.dedupeKey ?? JSON.stringify(record.totals)}`;

interface IndexRow {
  readonly meta: CachedFileMeta;
  readonly chunkCount: number;
  readonly lastRecord: string | null;
}

interface WriteRow {
  readonly path: string;
  readonly row: IndexRow;
  readonly head: string;
  /** Replaces every chunk when true; otherwise `chunks` are appended after the stored ones. */
  readonly replaceChunks: boolean;
  readonly firstChunkSeq: number;
  readonly chunks: readonly string[];
}

interface Backend {
  readonly persistent: boolean;
  readIndex(): Iterable<readonly [string, IndexRow]>;
  readEntry(path: string): { readonly head: string; readonly chunks: readonly string[] } | null;
  write(rows: readonly WriteRow[]): void;
  remove(paths: readonly string[]): void;
  readCoverage(): readonly ScanCoverage[];
  writeCoverage(coverage: ScanCoverage): void;
  readFlag(key: string): string | undefined;
  writeFlag(key: string, value: string): void;
  close(): void;
}

function memoryBackend(): Backend {
  const rows = new Map<string, { row: IndexRow; head: string; chunks: string[] }>();
  const coverage = new Map<string, ScanCoverage>();
  const flags = new Map<string, string>();
  return {
    persistent: false,
    readIndex: () => [...rows].map(([path, stored]) => [path, stored.row] as const),
    readEntry: (path) => {
      const stored = rows.get(path);
      return stored === undefined ? null : { head: stored.head, chunks: [...stored.chunks] };
    },
    write: (writes) => {
      for (const write of writes) {
        const previous = rows.get(write.path)?.chunks ?? [];
        rows.set(write.path, {
          row: write.row,
          head: write.head,
          chunks: write.replaceChunks ? [...write.chunks] : [...previous, ...write.chunks],
        });
      }
    },
    remove: (paths) => {
      for (const path of paths) rows.delete(path);
    },
    readCoverage: () => [...coverage.values()],
    writeCoverage: (entry) => {
      coverage.set(coverageKey(entry.provider, entry.rootPath), entry);
    },
    readFlag: (key) => flags.get(key),
    writeFlag: (key, value) => {
      flags.set(key, value);
    },
    close: () => {},
  };
}

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function sqliteBackend(filePath: string): Backend {
  const db = new NodeSqlite.DatabaseSync(filePath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const schema = db.prepare("SELECT value FROM store_meta WHERE key = 'schema'").get()?.value;
    if (schema !== STORE_SCHEMA_VERSION) {
      db.exec("DROP TABLE IF EXISTS chunks");
      db.exec("DROP TABLE IF EXISTS files");
      db.exec("DROP TABLE IF EXISTS coverage");
      db.exec("DELETE FROM store_meta");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      size REAL NOT NULL,
      mtime_ms REAL NOT NULL,
      scan_cursor REAL,
      scan_skipped_lines REAL,
      scan_discarding_line INTEGER NOT NULL,
      prefix_fingerprint TEXT,
      repeated_input_version INTEGER,
      has_codex_state INTEGER NOT NULL,
      has_repeated_input INTEGER NOT NULL,
      record_count INTEGER NOT NULL,
      latest_ms REAL NOT NULL,
      chunk_count INTEGER NOT NULL,
      last_record TEXT,
      head TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      path TEXT NOT NULL,
      seq INTEGER NOT NULL,
      records TEXT NOT NULL,
      PRIMARY KEY (path, seq)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS coverage (
      provider TEXT NOT NULL,
      root_path TEXT NOT NULL,
      since_ms REAL NOT NULL,
      scanned_at_ms REAL NOT NULL,
      volume_id TEXT,
      PRIMARY KEY (provider, root_path)
    )`);
    db.prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('schema', ?)").run(
      STORE_SCHEMA_VERSION,
    );
  } catch (error) {
    db.close();
    throw error;
  }

  const selectIndex = db.prepare(
    `SELECT path, provider, size, mtime_ms, scan_cursor, scan_skipped_lines,
      scan_discarding_line, prefix_fingerprint, repeated_input_version,
      has_codex_state, has_repeated_input, record_count, latest_ms, chunk_count,
      last_record FROM files`,
  );
  const selectHead = db.prepare("SELECT head FROM files WHERE path = ?");
  const selectChunks = db.prepare("SELECT records FROM chunks WHERE path = ? ORDER BY seq");
  const upsertFile = db.prepare(
    `INSERT OR REPLACE INTO files (path, provider, size, mtime_ms, scan_cursor,
      scan_skipped_lines, scan_discarding_line, prefix_fingerprint,
      repeated_input_version, has_codex_state, has_repeated_input, record_count,
      latest_ms, chunk_count, last_record, head)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertChunk = db.prepare(
    "INSERT OR REPLACE INTO chunks (path, seq, records) VALUES (?, ?, ?)",
  );
  const deleteChunks = db.prepare("DELETE FROM chunks WHERE path = ?");
  const deleteFile = db.prepare("DELETE FROM files WHERE path = ?");
  const selectCoverage = db.prepare(
    "SELECT provider, root_path, since_ms, scanned_at_ms, volume_id FROM coverage",
  );
  const upsertCoverage = db.prepare(
    `INSERT OR REPLACE INTO coverage (provider, root_path, since_ms, scanned_at_ms, volume_id)
      VALUES (?, ?, ?, ?, ?)`,
  );
  const selectFlag = db.prepare("SELECT value FROM store_meta WHERE key = ?");
  const upsertFlag = db.prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)");

  const inTransaction = (write: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      write();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    persistent: true,
    *readIndex() {
      for (const row of selectIndex.iterate()) {
        const path = row.path;
        const provider = row.provider;
        const size = optionalNumber(row.size);
        const mtimeMs = optionalNumber(row.mtime_ms);
        const latestMs = optionalNumber(row.latest_ms);
        const recordCount = optionalNumber(row.record_count);
        const chunkCount = optionalNumber(row.chunk_count);
        if (
          typeof path !== "string" ||
          typeof provider !== "string" ||
          !PROVIDERS.has(provider) ||
          size === undefined ||
          mtimeMs === undefined ||
          latestMs === undefined ||
          recordCount === undefined ||
          chunkCount === undefined
        ) {
          continue;
        }
        const scanCursor = optionalNumber(row.scan_cursor);
        const scanSkippedLines = optionalNumber(row.scan_skipped_lines);
        const repeatedInputVersion = optionalNumber(row.repeated_input_version);
        yield [
          path,
          {
            meta: {
              size,
              mtimeMs,
              provider: provider as UsageProviderKind,
              ...(scanCursor === undefined ? {} : { scanCursor }),
              ...(scanSkippedLines === undefined ? {} : { scanSkippedLines }),
              ...(row.scan_discarding_line === 1 ? { scanDiscardingLine: true } : {}),
              ...(typeof row.prefix_fingerprint === "string"
                ? { prefixFingerprint: row.prefix_fingerprint }
                : {}),
              ...(repeatedInputVersion === undefined ? {} : { repeatedInputVersion }),
              hasCodexState: row.has_codex_state === 1,
              hasRepeatedInput: row.has_repeated_input === 1,
              recordCount,
              latestMs,
            },
            chunkCount,
            lastRecord: typeof row.last_record === "string" ? row.last_record : null,
          },
        ] as const;
      }
    },
    readEntry: (path) => {
      const head = selectHead.get(path)?.head;
      if (typeof head !== "string") return null;
      const chunks: string[] = [];
      for (const row of selectChunks.iterate(path)) {
        if (typeof row.records !== "string") return null;
        chunks.push(row.records);
      }
      return { head, chunks };
    },
    write: (writes) =>
      inTransaction(() => {
        for (const { path, row, head, replaceChunks, firstChunkSeq, chunks } of writes) {
          const { meta } = row;
          upsertFile.run(
            path,
            meta.provider,
            meta.size,
            meta.mtimeMs,
            meta.scanCursor ?? null,
            meta.scanSkippedLines ?? null,
            meta.scanDiscardingLine === true ? 1 : 0,
            meta.prefixFingerprint ?? null,
            meta.repeatedInputVersion ?? null,
            meta.hasCodexState ? 1 : 0,
            meta.hasRepeatedInput ? 1 : 0,
            meta.recordCount,
            meta.latestMs,
            row.chunkCount,
            row.lastRecord,
            head,
          );
          if (replaceChunks) deleteChunks.run(path);
          chunks.forEach((records, index) => insertChunk.run(path, firstChunkSeq + index, records));
        }
      }),
    remove: (paths) =>
      inTransaction(() => {
        for (const path of paths) {
          deleteChunks.run(path);
          deleteFile.run(path);
        }
      }),
    readCoverage: () => {
      const coverage: ScanCoverage[] = [];
      for (const row of selectCoverage.iterate()) {
        const sinceMs = optionalNumber(row.since_ms);
        const scannedAtMs = optionalNumber(row.scanned_at_ms);
        if (
          typeof row.provider !== "string" ||
          !PROVIDERS.has(row.provider) ||
          typeof row.root_path !== "string" ||
          sinceMs === undefined ||
          scannedAtMs === undefined
        ) {
          continue;
        }
        coverage.push({
          provider: row.provider as UsageProviderKind,
          rootPath: row.root_path,
          sinceMs,
          scannedAtMs,
          ...(typeof row.volume_id === "string" ? { volumeId: row.volume_id } : {}),
        });
      }
      return coverage;
    },
    writeCoverage: (entry) => {
      upsertCoverage.run(
        entry.provider,
        entry.rootPath,
        entry.sinceMs,
        entry.scannedAtMs,
        entry.volumeId ?? null,
      );
    },
    readFlag: (key) => {
      const value = selectFlag.get(key)?.value;
      return typeof value === "string" ? value : undefined;
    },
    writeFlag: (key, value) => {
      upsertFlag.run(key, value);
    },
    close: () => db.close(),
  };
}

export const coverageKey = (provider: UsageProviderKind, rootPath: string) =>
  `${provider}\u0000${rootPath}`;

export interface UsageScanStoreOptions {
  /** Upper bound on retained decoded entries, measured in encoded characters. */
  readonly decodedCacheChars?: number;
}

/**
 * The scan cache's single owner. Reads and writes are synchronous and small;
 * callers treat returned entries as immutable because they may be shared by
 * the decode cache. The database opens on first use, so constructing the
 * owner costs nothing at server startup.
 */
export class UsageScanStore {
  readonly #openBackend: () => Backend;
  #backend: Backend | undefined;
  #indexLoaded = false;
  #openError: unknown = null;
  readonly #index = new Map<string, IndexRow>();
  readonly #meta = new Map<string, CachedFileMeta>();
  readonly #coverage = new Map<string, ScanCoverage>();
  /** Insertion-ordered, so the first key is the least recently used. */
  readonly #decoded = new Map<string, { readonly entry: CachedFile; readonly chars: number }>();
  /** Entries whose durable write failed; served from memory until a write lands. */
  readonly #unsaved = new Map<string, CachedFile>();
  readonly #decodedBudget: number;
  #decodedChars = 0;
  #lastWriteError: unknown = null;
  #revision = 0;

  private constructor(openBackend: () => Backend, options: UsageScanStoreOptions) {
    this.#openBackend = openBackend;
    this.#decodedBudget = options.decodedCacheChars ?? DEFAULT_DECODED_CACHE_CHARS;
  }

  /**
   * The durable store at `filePath`. A database that cannot be opened degrades
   * to a process-local store: usage still reads, it just starts cold next
   * launch. `openError` reports why once the store has been used.
   */
  static open(filePath: string, options: UsageScanStoreOptions = {}): UsageScanStore {
    return new UsageScanStore(() => sqliteBackend(filePath), options);
  }

  static memory(options: UsageScanStoreOptions = {}): UsageScanStore {
    return new UsageScanStore(memoryBackend, options);
  }

  #open(): Backend {
    if (this.#backend !== undefined) return this.#backend;
    let backend: Backend;
    try {
      backend = this.#openBackend();
    } catch (error) {
      this.#openError = error;
      backend = memoryBackend();
      // A process-local store starts empty; keep nothing the old database had.
      this.#indexLoaded = false;
      this.#index.clear();
      this.#meta.clear();
      this.#coverage.clear();
      this.#decoded.clear();
      this.#decodedChars = 0;
    }
    this.#backend = backend;
    if (this.#indexLoaded) return backend;
    this.#indexLoaded = true;
    for (const [path, row] of backend.readIndex()) {
      this.#index.set(path, row);
      this.#meta.set(path, row.meta);
    }
    for (const entry of backend.readCoverage()) {
      this.#coverage.set(coverageKey(entry.provider, entry.rootPath), entry);
    }
    return backend;
  }

  /** Why the durable database could not be opened, once the store has been used. */
  get openError(): unknown {
    return this.#openError;
  }

  get persistent(): boolean {
    return this.#open().persistent;
  }

  get size(): number {
    this.#open();
    return this.#index.size;
  }

  /** Increments on every change so derived results can tell they are current. */
  get revision(): number {
    return this.#revision;
  }

  /** The most recent durable write failure, if the latest attempt failed. */
  get lastWriteError(): unknown {
    return this.#lastWriteError;
  }

  meta(path: string): CachedFileMeta | undefined {
    this.#open();
    return this.#meta.get(path);
  }

  index(): ReadonlyMap<string, CachedFileMeta> {
    this.#open();
    return this.#meta;
  }

  /** Decodes one file's entry; a row that no longer decodes reads as missing. */
  load(path: string): CachedFile | undefined {
    const backend = this.#open();
    if (!this.#index.has(path)) return undefined;
    const unsaved = this.#unsaved.get(path);
    if (unsaved !== undefined) return unsaved;
    const hit = this.#decoded.get(path);
    if (hit !== undefined) {
      this.#decoded.delete(path);
      this.#decoded.set(path, hit);
      return hit.entry;
    }
    const stored = backend.readEntry(path);
    const head = stored === null ? undefined : decodeCachedFile(stored.head);
    let records: UsageRecord[] | undefined = head === undefined ? undefined : [];
    let chars = stored?.head.length ?? 0;
    for (const chunk of stored?.chunks ?? []) {
      const decoded = decodeCachedFile(chunk);
      if (decoded === undefined || records === undefined) {
        records = undefined;
        break;
      }
      for (const record of decoded.records) records.push(record);
      chars += chunk.length;
    }
    if (head === undefined || records === undefined) {
      // The index promised an entry the rows cannot supply. Forget it so the
      // transcript is parsed again instead of reading as permanently empty.
      this.#forget([path]);
      return undefined;
    }
    const entry: CachedFile = { ...head, records };
    this.#remember(path, entry, chars);
    return entry;
  }

  set(path: string, entry: CachedFile): void {
    this.setMany([[path, entry]]);
  }

  /** Writes every entry in one transaction, appending records when a file only grew. */
  setMany(entries: Iterable<readonly [string, CachedFile]>): void {
    const backend = this.#open();
    const writes: WriteRow[] = [];
    const remembered: [string, CachedFile, number][] = [];
    for (const [path, entry] of entries) {
      const previous = this.#index.get(path);
      const records = entry.records;
      const lastRecord = records.length === 0 ? null : recordSignature(records.at(-1)!);
      const previousCount = previous?.meta.recordCount ?? 0;
      const appendable =
        previous !== undefined &&
        previous.meta.provider === entry.provider &&
        previousCount <= records.length &&
        previous.chunkCount < MAX_CHUNKS_PER_FILE &&
        (previousCount === 0
          ? previous.lastRecord === null
          : recordSignature(records[previousCount - 1]!) === previous.lastRecord);
      const tail = appendable ? records.slice(previousCount) : records;
      const chunks =
        tail.length === 0
          ? []
          : [encodeCachedFile({ size: 0, mtimeMs: 0, provider: entry.provider, records: tail })];
      const head = encodeCachedFile({ ...entry, records: [] });
      const row: IndexRow = {
        meta: cachedFileMeta(entry),
        chunkCount: (appendable ? previous.chunkCount : 0) + chunks.length,
        lastRecord,
      };
      writes.push({
        path,
        row,
        head,
        replaceChunks: !appendable,
        firstChunkSeq: appendable ? previous.chunkCount : 0,
        chunks,
      });
      this.#index.set(path, row);
      this.#meta.set(path, row.meta);
      remembered.push([
        path,
        entry,
        head.length + chunks.reduce((total, chunk) => total + chunk.length, 0),
      ]);
    }
    if (writes.length === 0) return;
    this.#revision += 1;
    try {
      backend.write(writes);
      this.#lastWriteError = null;
      for (const { path } of writes) this.#unsaved.delete(path);
    } catch (error) {
      this.#lastWriteError = error;
      for (const [path, entry] of remembered) this.#unsaved.set(path, entry);
      // The stored chunks no longer match the index, so the next write of
      // these files must replace them rather than append.
      for (const { path, row } of writes) {
        this.#index.set(path, { ...row, chunkCount: MAX_CHUNKS_PER_FILE });
      }
    }
    for (const [path, entry, chars] of remembered) this.#remember(path, entry, chars);
  }

  delete(path: string): void {
    this.#forget([path]);
  }

  /** Drops entries whose latest usage is older than the retention cutoff. */
  prune(retentionCutoffMs: number): number {
    this.#open();
    const expired = [...this.#meta]
      .filter(([, meta]) => meta.latestMs < retentionCutoffMs)
      .map(([path]) => path);
    this.#forget(expired);
    return expired.length;
  }

  coverage(provider: UsageProviderKind, rootPath: string): ScanCoverage | undefined {
    this.#open();
    return this.#coverage.get(coverageKey(provider, rootPath));
  }

  coverageValues(): readonly ScanCoverage[] {
    this.#open();
    return [...this.#coverage.values()];
  }

  setCoverage(entry: ScanCoverage): void {
    const backend = this.#open();
    this.#coverage.set(coverageKey(entry.provider, entry.rootPath), entry);
    this.#revision += 1;
    try {
      backend.writeCoverage(entry);
    } catch (error) {
      this.#lastWriteError = error;
    }
  }

  readFlag(key: string): string | undefined {
    const backend = this.#open();
    try {
      return backend.readFlag(key);
    } catch {
      return undefined;
    }
  }

  writeFlag(key: string, value: string): void {
    const backend = this.#open();
    try {
      backend.writeFlag(key, value);
    } catch (error) {
      this.#lastWriteError = error;
    }
  }

  /**
   * Closes the database connection but keeps the index and decoded entries;
   * the next call reopens it. Holding no handle between scans lets the
   * database file be moved or removed while the server is idle.
   */
  release(): void {
    // A process-local store has nothing to reopen; releasing it would lose it.
    if (this.#backend === undefined || !this.#backend.persistent) return;
    const backend = this.#backend;
    this.#backend = undefined;
    backend.close();
  }

  /** Releases the database and forgets everything loaded from it. */
  close(): void {
    this.release();
    this.#indexLoaded = false;
    this.#decoded.clear();
    this.#decodedChars = 0;
    this.#index.clear();
    this.#meta.clear();
    this.#coverage.clear();
    this.#unsaved.clear();
  }

  #remember(path: string, entry: CachedFile, chars: number): void {
    const previous = this.#decoded.get(path);
    if (previous !== undefined) {
      this.#decoded.delete(path);
      this.#decodedChars -= previous.chars;
    }
    // An entry larger than the whole budget would only evict everything else.
    if (chars > this.#decodedBudget) return;
    this.#decoded.set(path, { entry, chars });
    this.#decodedChars += chars;
    for (const [oldest, value] of this.#decoded) {
      if (this.#decodedChars <= this.#decodedBudget) break;
      this.#decoded.delete(oldest);
      this.#decodedChars -= value.chars;
    }
  }

  #forget(paths: readonly string[]): void {
    if (paths.length === 0) return;
    for (const path of paths) {
      this.#index.delete(path);
      this.#meta.delete(path);
      this.#unsaved.delete(path);
      const decoded = this.#decoded.get(path);
      if (decoded !== undefined) {
        this.#decoded.delete(path);
        this.#decodedChars -= decoded.chars;
      }
    }
    this.#revision += 1;
    try {
      this.#open().remove(paths);
    } catch (error) {
      this.#lastWriteError = error;
    }
  }
}
