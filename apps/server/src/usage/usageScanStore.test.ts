// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";

import type { CachedFile } from "./usageScanCache.ts";
import { UsageScanStore } from "./usageScanStore.ts";
import { initialCodexScanState, type UsageRecord } from "./usageTranscripts.ts";

const directories: string[] = [];
const tempDatabase = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-usage-store-"));
  directories.push(directory);
  return NodePath.join(directory, "usage-scan-cache.sqlite");
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function record(timestampMs: number, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "codex",
    timestampMs,
    model: "gpt-6-sol",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 1_000,
      cacheCreationTokens: 0,
      outputTokens: 40,
      reasoningTokens: 5,
    },
    reportedCostUsd: null,
    dedupeKey: `codex:session-a:${timestampMs}`,
    turnId: "turn-1",
    ...overrides,
  };
}

function entry(records: readonly UsageRecord[], overrides: Partial<CachedFile> = {}): CachedFile {
  return {
    size: 1_000,
    mtimeMs: 1_786_000_000_000.25,
    provider: "codex",
    records,
    codexState: initialCodexScanState(),
    ...overrides,
  };
}

describe("UsageScanStore", () => {
  it("round-trips entries and keeps only an index resident across reopen", () => {
    const file = tempDatabase();
    const first = { store: UsageScanStore.open(file) };
    expect(first.store.persistent).toBe(true);
    expect(first.store.openError).toBeNull();
    const saved = entry([record(1_786_000_000_500), record(1_786_000_000_900)], {
      scanCursor: 600,
      prefixFingerprint: "abc",
    });
    first.store.set("/sessions/a.jsonl", saved);
    first.store.setCoverage({
      provider: "codex",
      rootPath: "/sessions",
      sinceMs: 1,
      scannedAtMs: 2,
      volumeId: "vol",
    });
    first.store.close();

    const store = UsageScanStore.open(file);
    expect(store.size).toBe(1);
    expect(store.meta("/sessions/a.jsonl")).toEqual({
      size: 1_000,
      mtimeMs: 1_786_000_000_000.25,
      provider: "codex",
      scanCursor: 600,
      prefixFingerprint: "abc",
      hasCodexState: true,
      hasRepeatedInput: false,
      recordCount: 2,
      latestMs: 1_786_000_000_900,
    });
    expect(store.load("/sessions/a.jsonl")).toEqual(saved);
    expect(store.coverage("codex", "/sessions")).toEqual({
      provider: "codex",
      rootPath: "/sessions",
      sinceMs: 1,
      scannedAtMs: 2,
      volumeId: "vol",
    });
    store.close();
  });

  it("appends only the new records when a transcript grew", () => {
    const file = tempDatabase();
    const store = UsageScanStore.open(file);
    store.setMany([
      ["/a.jsonl", entry([record(1)])],
      ["/b.jsonl", entry([record(2)])],
    ]);
    const revision = store.revision;
    const grown = entry([record(2), record(3)], { size: 2_000, scanCursor: 1_500 });
    store.set("/b.jsonl", grown);
    expect(store.revision).toBe(revision + 1);
    store.close();

    const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    const files = db.prepare("SELECT path, size, record_count FROM files ORDER BY path").all();
    const chunks = db.prepare("SELECT path, seq FROM chunks ORDER BY path, seq").all();
    db.close();
    expect(files).toEqual([
      { path: "/a.jsonl", size: 1_000, record_count: 1 },
      { path: "/b.jsonl", size: 2_000, record_count: 2 },
    ]);
    expect(chunks).toEqual([
      { path: "/a.jsonl", seq: 0 },
      { path: "/b.jsonl", seq: 0 },
      { path: "/b.jsonl", seq: 1 },
    ]);
    const reopened = UsageScanStore.open(file);
    expect(reopened.load("/b.jsonl")).toEqual(grown);
    reopened.close();
  });

  it("replaces the chunks when a transcript was re-parsed differently", () => {
    const file = tempDatabase();
    const store = UsageScanStore.open(file);
    store.set("/a.jsonl", entry([record(1), record(2)]));
    store.set("/a.jsonl", entry([record(1), record(3)]));
    store.set("/a.jsonl", entry([record(1), record(3), record(4)]));
    store.set("/a.jsonl", entry([]));
    store.set("/a.jsonl", entry([record(9)]));
    store.close();

    const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
    const chunks = db.prepare("SELECT seq FROM chunks WHERE path = '/a.jsonl'").all();
    db.close();
    expect(chunks).toEqual([{ seq: 0 }]);
    const reopened = UsageScanStore.open(file);
    expect(reopened.load("/a.jsonl")?.records.map((row) => row.timestampMs)).toEqual([9]);
    reopened.close();
  });

  it("evicts decoded entries without losing durable ones", () => {
    const store = UsageScanStore.open(tempDatabase(), { decodedCacheChars: 600 });
    const big = entry(Array.from({ length: 4 }, (_, index) => record(10 + index)));
    store.set("/one.jsonl", big);
    store.set("/two.jsonl", big);
    store.set("/three.jsonl", big);
    for (const path of ["/one.jsonl", "/two.jsonl", "/three.jsonl"]) {
      expect(store.load(path)).toEqual(big);
    }
    store.close();
  });

  it("forgets a row that no longer decodes so the transcript is parsed again", () => {
    const file = tempDatabase();
    const first = UsageScanStore.open(file);
    first.set("/a.jsonl", entry([record(1)]));
    first.close();
    const db = new NodeSqlite.DatabaseSync(file);
    db.prepare("UPDATE chunks SET records = '{not json' WHERE path = '/a.jsonl'").run();
    db.close();

    const store = UsageScanStore.open(file);
    expect(store.meta("/a.jsonl")).toBeDefined();
    expect(store.load("/a.jsonl")).toBeUndefined();
    expect(store.meta("/a.jsonl")).toBeUndefined();
    store.close();
  });

  it("prunes by the latest retained usage, not by mtime alone", () => {
    const store = UsageScanStore.open(tempDatabase());
    store.set("/old.jsonl", entry([record(100)], { mtimeMs: 50 }));
    store.set("/recent-record.jsonl", entry([record(5_000)], { mtimeMs: 50 }));
    expect(store.prune(1_000)).toBe(1);
    expect([...store.index().keys()]).toEqual(["/recent-record.jsonl"]);
    store.close();
  });

  it("rebuilds tables written by another layout version", () => {
    const file = tempDatabase();
    const first = UsageScanStore.open(file);
    first.set("/a.jsonl", entry([record(1)]));
    first.close();
    const db = new NodeSqlite.DatabaseSync(file);
    db.prepare("UPDATE store_meta SET value = '0' WHERE key = 'schema'").run();
    db.close();

    const store = UsageScanStore.open(file);
    expect(store.size).toBe(0);
    store.set("/b.jsonl", entry([record(2)]));
    expect(store.load("/b.jsonl")?.records).toHaveLength(1);
    store.close();
  });

  it("drops v2 records and coverage before reparsing native run IDs", () => {
    const file = tempDatabase();
    const first = UsageScanStore.open(file);
    first.set("/sessions/a.jsonl", entry([record(1, { nativeSessionId: "run-a" })]));
    first.setCoverage({
      provider: "codex",
      rootPath: "/sessions",
      sinceMs: 1,
      scannedAtMs: 2,
    });
    first.close();

    const db = new NodeSqlite.DatabaseSync(file);
    db.prepare("UPDATE store_meta SET value = '2' WHERE key = 'schema'").run();
    db.close();

    const reopened = UsageScanStore.open(file);
    expect(reopened.size).toBe(0);
    expect(reopened.coverage("codex", "/sessions")).toBeUndefined();
    reopened.close();
  });

  it("degrades to a process-local store when the database cannot open", () => {
    const directory = NodePath.dirname(tempDatabase());
    const store = UsageScanStore.open(directory);
    expect(store.persistent).toBe(false);
    expect(store.openError).not.toBeNull();
    store.set("/a.jsonl", entry([record(1)]));
    expect(store.load("/a.jsonl")?.records).toHaveLength(1);
  });
});
