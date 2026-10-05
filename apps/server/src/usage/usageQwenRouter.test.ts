// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  parseQwenRouterLine,
  readQwenRouterUsage,
  type QwenRouterUsageSource,
} from "./usageQwenRouter.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const source: QwenRouterUsageSource = {
  sourceId: "synthetic-router",
  files: [],
  additiveSources: ["otis", "otis-decisions", "synthetic-benchmark"],
};
const job = (fields: Record<string, unknown> = {}) => ({
  event: "job_finished",
  job_id: "synthetic-job-1",
  source: "otis-decisions",
  job_type: "decision",
  backend_target_kind: "local_llama",
  backend_target_id: "synthetic-local-backend",
  actual_model: "synthetic-qwen",
  end_time: "2026-10-05T05:00:00Z",
  prompt_tokens: 100,
  completion_tokens: 20,
  token_count: 120,
  prompt_tokens_source: "usage",
  request_id: "synthetic-request-1",
  router_run_id: "synthetic-router-run",
  ...fields,
});
const parse = (fields: Record<string, unknown> = {}) => {
  const outcome = parseQwenRouterLine(JSON.stringify(job(fields)), source);
  expect(outcome.kind).toBe("job");
  if (outcome.kind !== "job") throw new Error("Expected synthetic terminal job");
  return outcome.record;
};

async function fixture(run: (directory: string, source: QwenRouterUsageSource) => Promise<void>) {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "synthetic-router-usage-"),
  );
  try {
    await run(directory, {
      ...source,
      files: [NodePath.join(directory, "active.jsonl"), NodePath.join(directory, "archive.jsonl")],
    });
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
const writeRows = (file: string, rows: readonly unknown[]) =>
  NodeFSP.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

describe("parseQwenRouterLine", () => {
  it("returns exact job metadata without fabricating native identities, billing or measurements", () => {
    const record = parse();
    expect(record).toMatchObject({
      provider: "qwen-router",
      jobId: "synthetic-job-1",
      requestId: "synthetic-request-1",
      routerRunId: "synthetic-router-run",
      disposition: "additive",
      usageStatus: "partial",
      reportedCostUsd: null,
      nativeSessionId: null,
      providerResponseId: null,
      measured: {
        inputTokens: 100,
        outputTokens: null,
        cachedInputTokens: null,
        cacheCreationTokens: null,
        reasoningTokens: null,
      },
    });
    expect(record.timestampMs).toBe(1791176400000);
    expect(record.sessionId).toBe(record.dedupeKey);
    expect(record.recorded).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      inputSource: "usage",
    });
  });

  it.each([
    "codex",
    "Codex CLI",
    "codex-desktop",
    "codex_cli_worker",
    "openai_codex",
    "opencode",
    "Open Code",
    "opencode_cli",
  ])("excludes native traffic from %s", (native) => {
    expect(parse({ source: native })).toMatchObject({
      disposition: "excludedNative",
      nativeProvider:
        native.toLowerCase().includes("code") && !native.toLowerCase().includes("codex")
          ? "opencode"
          : "codex",
    });
  });

  it("excludes remote passthrough even when it advertises an additive source", () => {
    expect(parse({ backend_target_kind: "remote_openai_compatible" }).disposition).toBe(
      "excludedCloud",
    );
  });

  it("uses a native originator to exclude mislabeled traffic", () => {
    expect(parse({ client_originator: "codex" })).toMatchObject({
      disposition: "excludedNative",
      nativeProvider: "codex",
    });
    expect(parse({ source: "codex", client_originator: "opencode" })).toMatchObject({
      disposition: "unattributed",
      nativeProvider: null,
    });
  });

  it.each([null, "unknown", "custom-codex-route", "ua:opencode-client", "unregistered-client"])(
    "does not add ambiguous or unregistered source %s",
    (unknown) => {
      expect(parse({ source: unknown, job_type: "benchmark" }).disposition).toBe("unattributed");
    },
  );

  it.each([undefined, null, "hf_tokenizer", "estimated_chars_div4"])(
    "keeps input provenance %s out of measured totals",
    (inputSource) => {
      expect(parse({ prompt_tokens_source: inputSource })).toMatchObject({
        measured: { inputTokens: null, outputTokens: null },
        usageStatus: "missing",
      });
    },
  );

  it("does not invent counters from prompt text or quota percentages", () => {
    const record = parse({
      prompt_tokens: null,
      completion_tokens: null,
      token_count: null,
      prompt: "Synthetic ignored text",
      quota_percentage: 50,
    });
    expect(record.recorded).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(record.measured.inputTokens).toBeNull();
    expect(JSON.stringify(record)).not.toContain("Synthetic ignored text");
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "10", true])(
    "rejects invalid counter %s without rounding",
    (invalid) => {
      const outcome = parseQwenRouterLine(JSON.stringify(job({ prompt_tokens: invalid })), source);
      expect(outcome).toMatchObject({
        kind: "job",
        invalidCounters: 1,
        record: {
          disposition: "unattributed",
          recorded: { inputTokens: null },
          measured: { inputTokens: null },
        },
      });
    },
  );

  it("keeps zero measurements and missing terminal timestamps distinct", () => {
    expect(
      parse({ prompt_tokens: 0, completion_tokens: 0, token_count: 0 }).measured.inputTokens,
    ).toBe(0);
    expect(parse({ end_time: null, submitted_at: "2026-10-05T00:00:00Z" })).toMatchObject({
      timestampMs: null,
      disposition: "unattributed",
    });
    expect(parse({ end_time: "2026-10-05T00:00:00" }).timestampMs).toBeNull();
  });

  it("does not retain prompts, descriptions, errors, paths or credentials", () => {
    expect(
      JSON.stringify(
        parse({
          prompt: "synthetic-private",
          error: "synthetic-private",
          short_description: "synthetic-private",
          backend_base_url: "synthetic-private",
          authorization: "synthetic-private",
        }),
      ),
    ).not.toContain("synthetic-private");
  });

  it("distinguishes malformed, invalid and irrelevant rows", () => {
    for (const row of ["{", "[]", "null", "42"])
      expect(parseQwenRouterLine(row, source).kind).toBe("malformed");
    expect(parseQwenRouterLine(JSON.stringify(job({ job_id: "" })), source).kind).toBe("invalid");
    expect(parseQwenRouterLine(JSON.stringify({ event: "job_started" }), source).kind).toBe(
      "ignored",
    );
    expect(
      parseQwenRouterLine(
        JSON.stringify({
          schema_version: "qwen.router.model_usage.v1",
          route: "openai_passthrough",
          input_tokens: 200,
        }),
        source,
      ).kind,
    ).toBe("ignored");
  });
});

describe("readQwenRouterUsage with synthetic retained files", () => {
  it("counts active/archive copies once while retaining native exclusions", async () =>
    fixture(async (_directory, config) => {
      await writeRows(config.files[0]!, [
        job(),
        job({ job_id: "synthetic-native", source: "codex" }),
        job({ job_id: "synthetic-cloud", backend_target_kind: "remote_openai_compatible" }),
      ]);
      await writeRows(config.files[1]!, [job()]);
      const result = await readQwenRouterUsage(config);
      expect(result.status).toBe("complete");
      expect(result.records).toHaveLength(3);
      expect(result.counters.duplicateCopies).toBe(1);
      expect(
        result.records
          .filter((record) => record.disposition === "additive")
          .reduce((sum, record) => sum + (record.measured.inputTokens ?? 0), 0),
      ).toBe(100);
      expect(result.coverage.every((file) => file.status === "complete")).toBe(true);
    }));

  it.each(["prompt_tokens", "completion_tokens", "source", "request_id", "actual_model"])(
    "rejects conflicting %s copies regardless of file order",
    async (field) =>
      fixture(async (_directory, config) => {
        const conflict = job({ [field]: field.includes("tokens") ? 101 : "synthetic-conflict" });
        await writeRows(config.files[0]!, [job()]);
        await writeRows(config.files[1]!, [conflict, job()]);
        for (const files of [config.files, config.files.toReversed()]) {
          const result = await readQwenRouterUsage({ ...config, files });
          expect(result.status).toBe("partial");
          expect(result.records).toEqual([]);
          expect(result.counters.conflictingJobs).toBe(1);
          expect(result.rejectedJobKeys).toHaveLength(1);
        }
      }),
  );

  it("ignores private-field differences when deduping and separates router stores", async () =>
    fixture(async (_directory, config) => {
      await writeRows(config.files[0]!, [job({ prompt: "synthetic-a" })]);
      await writeRows(config.files[1]!, [job({ prompt: "synthetic-b" })]);
      const first = await readQwenRouterUsage(config);
      const second = await readQwenRouterUsage({ ...config, sourceId: "synthetic-other-router" });
      expect(first.records).toHaveLength(1);
      expect(first.records[0]?.dedupeKey).not.toBe(second.records[0]?.dedupeKey);
    }));

  it("reports malformed, invalid, missing and unknown counters without losing other jobs", async () =>
    fixture(async (_directory, config) => {
      await NodeFSP.writeFile(
        config.files[0]!,
        [
          "{",
          JSON.stringify(job({ job_id: "" })),
          JSON.stringify(job({ completion_tokens: -1 })),
          JSON.stringify(
            job({
              job_id: "synthetic-unknown",
              source: null,
              prompt_tokens: null,
              completion_tokens: null,
              token_count: null,
            }),
          ),
          JSON.stringify(job({ event: "job_started" })),
        ].join("\n") + "\n",
      );
      const result = await readQwenRouterUsage(config);
      expect(result.status).toBe("partial");
      expect(result.counters).toMatchObject({
        rows: 5,
        malformedRows: 1,
        invalidRows: 1,
        invalidCounters: 1,
        unknownCounters: 3,
        unknownMeasuredCounters: 3,
        unknownSources: 1,
        ignoredRows: 1,
      });
      expect(result.coverage[1]?.status).toBe("missing");
    }));

  it("reports all missing files and rejects directories as unavailable", async () =>
    fixture(async (directory, config) => {
      expect((await readQwenRouterUsage(config)).status).toBe("missing");
      const result = await readQwenRouterUsage({ ...config, files: [directory] });
      expect(result.status).toBe("partial");
      expect(result.coverage[0]?.status).toBe("unavailable");
    }));

  it("dedupes repeated paths and obeys the file bound", async () =>
    fixture(async (_directory, config) => {
      await writeRows(config.files[0]!, [job()]);
      await writeRows(config.files[1]!, [job({ job_id: "synthetic-second" })]);
      const result = await readQwenRouterUsage(
        { ...config, files: [config.files[0]!, ...config.files] },
        { maxFiles: 1 },
      );
      expect(result.records).toHaveLength(1);
      expect(result.coverage).toHaveLength(2);
      expect(result.coverage[1]?.status).toBe("notRead");
      expect(result.status).toBe("partial");
    }));

  it("bounds bytes across files and does not parse an unfinished prefix", async () =>
    fixture(async (_directory, config) => {
      await writeRows(config.files[0]!, [job()]);
      await writeRows(config.files[1]!, [job()]);
      const result = await readQwenRouterUsage(config, { maxBytes: 20 });
      expect(result.records).toEqual([]);
      expect(result.coverage.reduce((sum, file) => sum + file.bytesRead, 0)).toBe(20);
      expect(result.status).toBe("partial");
      expect(result.counters.malformedRows).toBe(0);
    }));

  it("bounds rows and retained job identities", async () =>
    fixture(async (_directory, config) => {
      await writeRows(config.files[0]!, [
        job(),
        job({ job_id: "synthetic-second" }),
        job({ job_id: "synthetic-third" }),
      ]);
      for (const limit of [{ maxRows: 1 }, { maxJobs: 1 }]) {
        const result = await readQwenRouterUsage(config, limit);
        expect(result.records).toHaveLength(1);
        expect(result.status).toBe("partial");
      }
    }));

  it("skips a multi-chunk oversized row and recovers at its newline", async () =>
    fixture(async (_directory, config) => {
      await writeRows(config.files[0]!, [
        job({ prompt: "x".repeat(150_000) }),
        job({ job_id: "synthetic-small" }),
      ]);
      const result = await readQwenRouterUsage(
        { ...config, files: [config.files[0]!] },
        { maxLineBytes: 1024 },
      );
      expect(result.records.map((record) => record.jobId)).toEqual(["synthetic-small"]);
      expect(result.counters.oversizedRows).toBe(1);
      expect(result.status).toBe("partial");
    }));

  it("waits for a final newline and does not treat an append fragment as malformed", async () =>
    fixture(async (_directory, config) => {
      await NodeFSP.writeFile(config.files[0]!, JSON.stringify(job()));
      expect((await readQwenRouterUsage(config)).records).toEqual([]);
      await NodeFSP.appendFile(config.files[0]!, "\r\n");
      expect((await readQwenRouterUsage(config)).records).toHaveLength(1);
    }));

  it("reports a file appended during a read without claiming complete coverage", async () =>
    fixture(async (_directory, config) => {
      const file = config.files[0]!;
      await writeRows(file, [job()]);
      const handle = await NodeFSP.open(file, "r");
      const originalStat = handle.stat.bind(handle);
      const open = vi.mocked(NodeFSP.open).mockResolvedValueOnce(handle);
      const stat = vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const before = await originalStat();
        await NodeFSP.appendFile(
          file,
          JSON.stringify(job({ job_id: "synthetic-appended" })) + "\n",
        );
        return before;
      });
      try {
        const result = await readQwenRouterUsage({ ...config, files: [file] });
        expect(result.status).toBe("partial");
        expect(result.coverage[0]).toMatchObject({
          status: "partial",
          changedDuringRead: true,
          reason: "changed",
        });
        expect(result.records.map((record) => record.jobId)).toEqual(["synthetic-job-1"]);
      } finally {
        stat.mockRestore();
        open.mockRestore();
        await handle.close();
      }
    }));

  it("rejects malformed UTF-8 rather than changing job identity", async () =>
    fixture(async (_directory, config) => {
      const corrupted = Buffer.from(JSON.stringify(job()) + "\n");
      corrupted[corrupted.indexOf("synthetic-job-1")] = 0xff;
      await NodeFSP.writeFile(config.files[0]!, corrupted);
      const result = await readQwenRouterUsage({ ...config, files: [config.files[0]!] });
      expect(result.records).toEqual([]);
      expect(result.counters.malformedRows).toBe(1);
      expect(result.status).toBe("partial");
    }));

  it("rejects unsafe configuration and invalid bounds", async () =>
    fixture(async (_directory, config) => {
      await expect(readQwenRouterUsage({ ...config, files: ["relative.jsonl"] })).rejects.toThrow(
        TypeError,
      );
      await expect(readQwenRouterUsage({ ...config, additiveSources: ["codex"] })).rejects.toThrow(
        TypeError,
      );
      await expect(readQwenRouterUsage({ ...config, sourceId: "" })).rejects.toThrow(TypeError);
      await expect(readQwenRouterUsage(config, { maxBytes: 0 })).rejects.toThrow(TypeError);
    }));
});
