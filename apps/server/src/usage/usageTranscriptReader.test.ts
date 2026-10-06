// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  readRepeatedInputRecords,
  readTranscriptRecords,
  readTranscriptPrefixFingerprint,
  listTranscriptFilesBounded,
  listTranscriptFiles,
  selectTranscriptFilesForScan,
  transcriptAppendIsSafe,
  transcriptCursorIsLineBoundary,
  type TranscriptFile,
} from "./usageTranscriptReader.ts";
import { createRepeatedInputCatalog } from "./usageRepeatedInput.ts";

const file = (path: string, size: number, mtimeMs: number): TranscriptFile => ({
  path,
  size,
  mtimeMs,
});

describe("selectTranscriptFilesForScan", () => {
  it("selects newest cold files within the byte budget", () => {
    const selection = selectTranscriptFilesForScan(
      [file("old", 40, 1), file("new", 60, 3), file("middle", 50, 2)],
      ({ size }) => size,
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["new", "old"]);
    expect(selection.coldBytes).toBe(100);
    expect(selection.deferredFiles).toBe(1);
    expect(selection.deferredBytes).toBe(50);
  });

  it("always includes warm files without charging the cold budget", () => {
    const selection = selectTranscriptFilesForScan(
      [file("warm", 500, 3), file("cold", 100, 2)],
      ({ path, size }) => (path === "warm" ? 0 : size),
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["warm", "cold"]);
    expect(selection.coldBytes).toBe(100);
    expect(selection.deferredFiles).toBe(0);
  });

  it("only charges the changed transcript when the rest are warm", () => {
    const selection = selectTranscriptFilesForScan(
      [file("unchanged-a", 500, 3), file("edited", 60, 2), file("unchanged-b", 400, 1)],
      ({ path, size }) => (path !== "edited" ? 0 : size),
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual([
      "unchanged-a",
      "edited",
      "unchanged-b",
    ]);
    expect(selection.coldBytes).toBe(60);
    expect(selection.deferredFiles).toBe(0);
  });

  it("returns smaller files before an oversized transcript", () => {
    const selection = selectTranscriptFilesForScan(
      [file("oversized", 1_000, 3), file("small", 50, 2)],
      ({ size }) => size,
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["small"]);
    expect(selection.deferredFiles).toBe(1);
    expect(selection.deferredBytes).toBe(1_000);
    expect(selection.coldBytes).toBe(50);
  });

  it("selects one oversized transcript when it is the only cold work", () => {
    const selection = selectTranscriptFilesForScan(
      [file("oversized", 1_000, 3)],
      ({ size }) => size,
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["oversized"]);
    expect(selection.deferredFiles).toBe(0);
    expect(selection.deferredBytes).toBe(0);
    expect(selection.coldBytes).toBe(1_000);
  });

  it("selects a formerly oversized transcript after newer files become warm", () => {
    const selection = selectTranscriptFilesForScan(
      [file("new", 60, 3), file("oversized", 1_000, 2)],
      ({ path, size }) => (path === "new" ? 0 : size),
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["new", "oversized"]);
    expect(selection.deferredFiles).toBe(0);
  });

  it("does not starve oversized history while active rollouts only append", () => {
    const selection = selectTranscriptFilesForScan(
      [file("active", 2_000, 3), file("oversized", 1_000, 2), file("oversized-2", 900, 1)],
      ({ path, size }) => (path === "active" ? 40 : size),
      100,
    );

    expect(selection.files.map(({ path }) => path)).toEqual(["active", "oversized"]);
    expect(selection.deferredFiles).toBe(1);
    expect(selection.deferredBytes).toBe(900);
    expect(selection.coldBytes).toBe(1_040);
  });

  it("budgets only appended bytes so growing large chats do not starve other files", () => {
    const selection = selectTranscriptFilesForScan(
      [
        { ...file("active-large", 200_000_000, 3), startByte: 199_960_000 },
        { ...file("active-small", 70_000_000, 2), startByte: 69_900_000 },
        { ...file("cold", 50_000_000, 1), startByte: 0 },
      ],
      ({ size, startByte }) => size - startByte,
      128 * 1024 * 1024,
    );
    expect(selection.files.map(({ path }) => path)).toEqual([
      "active-large",
      "active-small",
      "cold",
    ]);
    expect(selection.coldBytes).toBe(50_140_000);
    expect(selection.deferredFiles).toBe(0);
  });
});

describe("incremental transcript reads", () => {
  it("marks an inventory incomplete when its deadline has already elapsed", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-usage-list-deadline-"),
    );
    try {
      const listing = await listTranscriptFilesBounded(directory, 0, "codex", -1);
      expect(listing).toEqual({ files: [], complete: false });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("lists nested recent transcripts with bounded metadata batches and excludes other files", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-list-"));
    const nested = NodePath.join(directory, "nested");
    try {
      await NodeFSP.mkdir(nested);
      await Promise.all(
        Array.from({ length: 70 }, (_, index) =>
          NodeFSP.writeFile(NodePath.join(nested, `${index}.jsonl`), "{}\n"),
        ),
      );
      await NodeFSP.writeFile(NodePath.join(directory, "ignore.txt"), "text");
      const old = NodePath.join(directory, "old.jsonl");
      await NodeFSP.writeFile(old, "{}\n");
      await NodeFSP.utimes(old, 1, 1);
      const files = await listTranscriptFiles(directory, 2_000, "codex");
      expect(files).toHaveLength(70);
      expect(files.every((file) => file.path.startsWith(nested) && file.size === 3)).toBe(true);
      expect(await listTranscriptFiles(NodePath.join(directory, "missing"), 0, "codex")).toEqual(
        [],
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes an expired inventory from discovered files instead of restarting its walk", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-inventory-"));
    try {
      await Promise.all(
        Array.from({ length: 129 }, (_, index) =>
          NodeFSP.writeFile(NodePath.join(directory, `${index}.jsonl`), "{}\n"),
        ),
      );
      const expiresAfterOneBatch = () => {
        let calls = 0;
        return () => (calls++ < 2 ? 0 : 2);
      };
      const first = await listTranscriptFilesBounded(
        directory,
        0,
        "codex",
        1,
        expiresAfterOneBatch(),
      );
      expect(first).toEqual({ files: [], complete: false });

      const second = await listTranscriptFilesBounded(
        directory,
        1,
        "codex",
        1,
        expiresAfterOneBatch(),
      );
      expect(second.complete).toBe(false);
      expect(second.files).toHaveLength(128);

      const complete = await listTranscriptFilesBounded(
        directory,
        0,
        "codex",
        Number.POSITIVE_INFINITY,
      );
      expect(complete).toMatchObject({ complete: true });
      expect(complete.files).toHaveLength(129);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("refreshes a known inventory from changed directories and recent transcripts", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-known-"));
    const oldDay = NodePath.join(directory, "2026", "08", "01");
    const today = NodePath.join(directory, "2026", "09", "28");
    try {
      await NodeFSP.mkdir(oldDay, { recursive: true });
      await NodeFSP.mkdir(today, { recursive: true });
      const old = NodePath.join(oldDay, "old.jsonl");
      const active = NodePath.join(today, "active.jsonl");
      await NodeFSP.writeFile(old, "{}\n");
      await NodeFSP.utimes(old, 1_000, 1_000);
      await NodeFSP.writeFile(active, "{}\n");
      let wall = performance.timeOrigin + performance.now();
      const clock = () => wall;
      const list = () =>
        listTranscriptFilesBounded(
          directory,
          0,
          "codex",
          Number.POSITIVE_INFINITY,
          undefined,
          clock,
        );
      expect((await list()).files).toHaveLength(2);

      // A recent transcript grows and a new one appears; both are seen without a full walk.
      await NodeFSP.appendFile(active, "{}\n");
      const added = NodePath.join(today, "added.jsonl");
      await NodeFSP.writeFile(added, "{}\n");
      wall += 60_000;
      const refreshed = await list();
      expect(refreshed.complete).toBe(true);
      expect(refreshed.files.find((file) => file.path === active)?.size).toBe(6);
      expect(refreshed.files.map((file) => file.path).sort()).toEqual([active, added, old].sort());

      // A deleted directory's transcripts disappear.
      await NodeFSP.rm(oldDay, { recursive: true, force: true });
      wall += 60_000;
      expect((await list()).files.map((file) => file.path).sort()).toEqual([active, added].sort());

      // An old transcript's append is left to the periodic full walk.
      await NodeFSP.mkdir(oldDay, { recursive: true });
      await NodeFSP.writeFile(old, "{}\n");
      await NodeFSP.utimes(old, 1_000, 1_000);
      wall += 6 * 60_000;
      expect((await list()).files.some((file) => file.path === old)).toBe(true);
      await NodeFSP.appendFile(old, "{}\n");
      await NodeFSP.utimes(old, 1_000, 1_000);
      wall += 60_000;
      expect((await list()).files.find((file) => file.path === old)?.size).toBe(3);
      wall += 6 * 60_000;
      expect((await list()).files.find((file) => file.path === old)?.size).toBe(6);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes a growing Codex JSONL file without rereading its prefix", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-append-"));
    const path = NodePath.join(directory, "rollout.jsonl");
    const first =
      [
        JSON.stringify({
          timestamp: "2026-08-29T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "session-a" },
        }),
        JSON.stringify({
          timestamp: "2026-08-29T10:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.6-sol" },
        }),
        JSON.stringify({
          timestamp: "2026-08-29T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2 },
            },
          },
        }),
      ].join("\n") + "\n";
    const second =
      JSON.stringify({
        timestamp: "2026-08-29T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4 },
          },
        },
      }) + "\n";

    try {
      await NodeFSP.writeFile(path, first);
      const initial = await readTranscriptRecords(path, "codex", { endByte: first.length - 1 });
      expect(initial?.records).toHaveLength(1);
      expect(await transcriptCursorIsLineBoundary(path, first.length)).toBe(true);
      const codexState = initial?.codexState;
      if (codexState === undefined) throw new Error("Codex parser state was not returned");

      await NodeFSP.appendFile(path, second);
      const appended = await readTranscriptRecords(path, "codex", {
        startByte: first.length,
        endByte: first.length + second.length - 1,
        codexState,
      });

      expect(appended?.records).toHaveLength(1);
      expect(appended?.records[0]?.model).toBe("gpt-5.6-sol");
      expect(appended?.records[0]?.sessionId).toBe("session-a");
      expect(appended?.records[0]?.totals.outputTokens).toBe(4);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a complete-line cursor when a bounded JSONL read ends mid-record", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-cursor-"));
    const path = NodePath.join(directory, "rollout.jsonl");
    const prefix =
      [
        JSON.stringify({
          timestamp: "2026-08-29T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "session-a" },
        }),
        JSON.stringify({
          timestamp: "2026-08-29T10:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.6-sol" },
        }),
        JSON.stringify({
          timestamp: "2026-08-29T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2 },
            },
          },
        }),
      ].join("\n") + "\n";
    const finalRecord =
      JSON.stringify({
        timestamp: "2026-08-29T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4 },
          },
        },
      }) + "\n";
    const contents = `${prefix}${finalRecord}`;
    try {
      await NodeFSP.writeFile(path, contents);
      const prefixBytes = Buffer.byteLength(prefix);
      const partial = await readTranscriptRecords(path, "codex", {
        endByte: prefixBytes + 2,
        sourceSize: Buffer.byteLength(contents),
      });
      expect(partial?.nextByte).toBe(prefixBytes);
      expect(partial?.records).toHaveLength(1);
      expect(await transcriptCursorIsLineBoundary(path, partial!.nextByte)).toBe(true);

      const resumed = await readTranscriptRecords(path, "codex", {
        startByte: partial!.nextByte,
        endByte: Buffer.byteLength(contents) - 1,
        sourceSize: Buffer.byteLength(contents),
        ...(partial!.codexState === undefined ? {} : { codexState: partial!.codexState }),
      });
      expect(resumed?.nextByte).toBe(Buffer.byteLength(contents));
      expect(resumed?.records).toHaveLength(1);
      expect(resumed?.records[0]).toMatchObject({
        sessionId: "session-a",
        model: "gpt-5.6-sol",
        totals: { outputTokens: 4 },
      });
      const complete = await readTranscriptRecords(path, "codex", {
        sourceSize: Buffer.byteLength(contents),
      });
      expect([...(partial?.records ?? []), ...(resumed?.records ?? [])]).toEqual(complete?.records);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("reads a large compaction record without making usage permanently incomplete", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-compacted-"));
    const path = NodePath.join(directory, "rollout.jsonl");
    const contents =
      [
        { type: "session_meta", payload: { id: "session-a" } },
        { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
        { type: "compacted", payload: { message: "x".repeat(5 * 1024 * 1024) } },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } },
          },
        },
      ]
        .map((record) => JSON.stringify({ timestamp: "2026-08-29T10:00:02.000Z", ...record }))
        .join("\n") + "\n";
    try {
      await NodeFSP.writeFile(path, contents);
      const result = await readTranscriptRecords(path, "codex");
      expect(result?.discardedLines).toBe(0);
      expect(result?.discardingLine).toBe(false);
      expect(result?.records).toMatchObject([{ totals: { outputTokens: 2 } }]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("skips an oversized record that cannot carry usage and keeps the transcript complete", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-oversized-"));
    const path = NodePath.join(directory, "rollout.jsonl");
    const prefix =
      [
        JSON.stringify({
          timestamp: "2026-08-29T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "session-a" },
        }),
        JSON.stringify({
          timestamp: "2026-08-29T10:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.6-sol" },
        }),
      ].join("\n") + "\n";
    const oversized = `${JSON.stringify({ type: "event_msg", payload: { text: "x".repeat(8 * 1024 * 1024 + 1) } })}\n`;
    const usage =
      JSON.stringify({
        timestamp: "2026-08-29T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 2 },
          },
        },
      }) + "\n";
    const contents = `${prefix}${oversized}${usage}`;
    try {
      await NodeFSP.writeFile(path, contents);
      const first = await readTranscriptRecords(path, "codex", {
        endByte: Buffer.byteLength(prefix) + 8 * 1024 * 1024,
        sourceSize: Buffer.byteLength(contents),
      });
      // The skipped line is finished in the same read, past the range end.
      expect(first?.discardingLine).toBe(false);
      expect(first?.discardedLines).toBe(0);
      expect(first?.nextByte).toBe(Buffer.byteLength(prefix) + Buffer.byteLength(oversized));
      expect(first?.records).toEqual([]);

      const second = await readTranscriptRecords(path, "codex", {
        startByte: first!.nextByte,
        endByte: Buffer.byteLength(contents) - 1,
        sourceSize: Buffer.byteLength(contents),
        ...(first!.codexState === undefined ? {} : { codexState: first!.codexState }),
      });
      expect(second?.nextByte).toBe(Buffer.byteLength(contents));
      expect(second?.discardingLine).toBe(false);
      expect(second?.discardedLines).toBe(0);
      expect(second?.records).toMatchObject([{ totals: { outputTokens: 2 } }]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("counts an oversized record that could carry usage as missing coverage", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-oversized-"));
    const codexPath = NodePath.join(directory, "rollout.jsonl");
    const claudePath = NodePath.join(directory, "session.jsonl");
    const padding = "x".repeat(10 * 1024 * 1024);
    const codexUsage = `${JSON.stringify({
      timestamp: "2026-08-29T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { padding } },
    })}\n`;
    // A tool output that quotes a usage event is not one.
    const codexQuote = `${JSON.stringify({
      timestamp: "2026-08-29T10:00:03.000Z",
      type: "response_item",
      payload: { type: "function_call_output", output: `${padding}"type":"token_count"` },
    })}\n`;
    // Claude writes usage after the content, deep inside an oversized line.
    const claudeUsage = `${JSON.stringify({
      message: { id: "msg_1", content: padding, usage: { output_tokens: 2 } },
      type: "assistant",
    })}\n`;
    try {
      await NodeFSP.writeFile(codexPath, codexUsage + codexQuote);
      const codex = await readTranscriptRecords(codexPath, "codex", {
        endByte: 11 * 1024 * 1024,
        sourceSize: Buffer.byteLength(codexUsage + codexQuote),
      });
      expect(codex?.discardedLines).toBe(1);
      expect(codex?.nextByte).toBe(Buffer.byteLength(codexUsage));
      const quote = await readTranscriptRecords(codexPath, "codex", {
        startByte: codex!.nextByte,
      });
      expect(quote?.discardedLines).toBe(0);

      await NodeFSP.writeFile(claudePath, claudeUsage);
      const claude = await readTranscriptRecords(claudePath, "claude");
      expect(claude?.discardedLines).toBe(1);

      // A skip resumed from an older read cannot see the line's start.
      const resumed = await readTranscriptRecords(codexPath, "codex", {
        startByte: Buffer.byteLength(codexUsage) + 1024 * 1024,
        discardPartialLine: true,
      });
      expect(resumed?.discardedLines).toBe(1);
      expect(resumed?.nextByte).toBe(Buffer.byteLength(codexUsage + codexQuote));
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("validates an append cursor against the unchanged prefix", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-prefix-"));
    const path = NodePath.join(directory, "rollout.jsonl");
    const prefix = '{"type":"session_meta","payload":{"id":"s"}}\n';
    try {
      await NodeFSP.writeFile(path, prefix);
      const fingerprint = await readTranscriptPrefixFingerprint(path, Buffer.byteLength(prefix));
      expect(fingerprint).not.toBeNull();
      expect(
        await transcriptAppendIsSafe(path, {
          offset: Buffer.byteLength(prefix),
          prefixFingerprint: fingerprint!,
        }),
      ).toBe(true);
      await NodeFSP.writeFile(path, `{"changed":true}\n${prefix}`);
      expect(
        await transcriptAppendIsSafe(path, {
          offset: Buffer.byteLength(prefix),
          prefixFingerprint: fingerprint!,
        }),
      ).toBe(false);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("imports only appended Codex evidence and keeps raw source text local", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-repeat-"));
    const path = NodePath.join(directory, "rollout.jsonl");
    const skill = "private skill contents";
    const catalog = createRepeatedInputCatalog([
      { path: NodePath.join(directory, "SKILL.md"), content: skill, tokenCount: 3 },
    ]);
    const first =
      [
        JSON.stringify({
          timestamp: "2026-09-13T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "session-a" },
        }),
        JSON.stringify({
          timestamp: "2026-09-13T00:00:01.000Z",
          type: "turn_context",
          payload: { turn_id: "turn-a", model: "gpt-5.6-sol" },
        }),
      ].join("\n") + "\n";
    const appended =
      JSON.stringify({
        timestamp: "2026-09-13T00:00:02.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call_output", id: "output-a", output: skill },
      }) + "\n";
    try {
      await NodeFSP.writeFile(path, first);
      const initial = await readRepeatedInputRecords(path, {
        endByte: Buffer.byteLength(first) - 1,
        catalog,
      });
      expect(initial?.observations).toEqual([]);
      await NodeFSP.appendFile(path, appended);
      const next = await readRepeatedInputRecords(path, {
        startByte: Buffer.byteLength(first),
        catalog,
        ...(initial?.parserState === undefined ? {} : { parserState: initial.parserState }),
      });
      expect(next?.observations).toHaveLength(1);
      expect(JSON.stringify(next?.observations)).not.toContain(skill);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
