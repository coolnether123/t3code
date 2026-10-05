// @effect-diagnostics nodeBuiltinImport:off - tests use disposable metadata files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { UsageDay, UsageReportObservations, type UsageReportInput } from "@t3tools/contracts";
import { readUsageObservations } from "./usageObservations.ts";
const decodeReport = Schema.decodeUnknownSync(UsageReportObservations);

const input: UsageReportInput = {
  mode: "observations",
  sinceDay: UsageDay.make("2026-10-05"),
  untilDay: UsageDay.make("2026-10-05"),
  timeZone: "America/Chicago",
};
const readAt = "2026-10-05T14:00:00Z";
const tokens = {
  inputTokens: 20,
  outputTokens: 5,
  cachedReadTokens: null,
  cachedWriteTokens: null,
  thoughtTokens: null,
  totalTokens: 25,
};
const prompt = (fields: Record<string, unknown> = {}) => ({
  version: 1,
  provider: "cursor",
  nativeSessionId: "session-1",
  turnId: "turn-1",
  requestId: "request-1",
  source: "prompt-response",
  tokenBasis: "request",
  reportedTokens: tokens,
  requestTokens: tokens,
  scopeConflict: false,
  invalidFields: [],
  outcome: "succeeded",
  receiptConflict: false,
  previousReportedTokens: null,
  acknowledgementMismatch: false,
  ...fields,
});
const nativeLine = (
  payload: unknown,
  id = '["cursor","session-1","turn-1","request-1"]',
  observedAt = "2026-10-05T13:00:00Z",
) =>
  `[${observedAt}] NTIVE: ${JSON.stringify({ observedAt, event: { id, kind: "usage", payload } })}\n`;

async function withFile(run: (file: string) => Promise<void>) {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "synthetic-usage-observations-"),
  );
  try {
    await run(NodePath.join(directory, "metadata.log"));
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
const acpConfiguration = (files: string[]) =>
  JSON.stringify([{ kind: "acp", sourceId: "synthetic-acp", provider: "cursor", files }]);

describe("usage observations", () => {
  it("reports unconfigured sources as missing, never exact zero coverage", async () => {
    const report = await readUsageObservations(input, { readAt });
    expect(report.coverage.status).toBe("missing");
    expect(report.coverage.reasons).toEqual(["sources-unconfigured"]);
    expect(report).not.toHaveProperty("totals");
    expect(report).not.toHaveProperty("calculation");
    expect(decodeReport(report)).toEqual(report);
  });

  it("reads tuple receipt identities and retains unknown counters without pricing them", async () => {
    await withFile(async (file) => {
      await NodeFSP.writeFile(
        file,
        nativeLine(prompt()) + nativeLine(prompt(), undefined, "2026-10-05T13:01:00Z"),
      );
      const report = await readUsageObservations(input, {
        readAt,
        configuration: acpConfiguration([file]),
      });
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toMatchObject({
        provider: "cursor",
        runId: "session-1",
        turnId: "turn-1",
        requestId: "request-1",
        basis: "measured",
        counters: { inputTokens: 20, outputTokens: 5, cachedInputTokens: null },
        reportedCost: null,
      });
      expect(report.coverage.duplicateRecords).toBe(1);
      expect(report.coverage.status).toBe("partial");
      expect(JSON.stringify(report)).not.toContain(file);
      expect(decodeReport(report)).toEqual(report);
    });
  });

  it("rejects conflicting exact receipts, including later repeated copies", async () => {
    await withFile(async (file) => {
      await NodeFSP.writeFile(
        file,
        nativeLine(prompt()) +
          nativeLine(prompt({ requestTokens: { ...tokens, outputTokens: 6 } })) +
          nativeLine(prompt()),
      );
      const report = await readUsageObservations(input, {
        readAt,
        configuration: acpConfiguration([file]),
      });
      expect(report.rows).toEqual([]);
      expect(report.coverage.conflictingRecords).toBe(1);
      expect(report.coverage.reasons).toContain("conflicting-receipt");
    });
  });

  it("keeps cumulative session costs separate from per-request tokens", async () => {
    await withFile(async (file) => {
      await NodeFSP.writeFile(
        file,
        nativeLine(
          {
            version: 1,
            provider: "cursor",
            nativeSessionId: "session-1",
            turnId: null,
            requestId: null,
            source: "usage-update",
            tokenBasis: "session",
            contextUsedTokens: 80,
            contextSizeTokens: 1000,
            sessionCost: { amount: 1.25, currency: "USD" },
            invalidFields: [],
          },
          "session-update-1",
        ),
      );
      const report = await readUsageObservations(input, {
        readAt,
        configuration: acpConfiguration([file]),
      });
      expect(report.rows[0]).toMatchObject({
        basis: "session",
        counters: { inputTokens: null, outputTokens: null },
        contextUsedTokens: 80,
        reportedCost: { amount: 1.25, scope: "session" },
      });
      expect(report.rows[0]?.issues).toContain("session-cost-not-request-cost");
    });
  });

  it("counts malformed lines, preserves good rows and marks partial records", async () => {
    await withFile(async (file) => {
      await NodeFSP.writeFile(
        file,
        nativeLine(prompt()) + "[2026-10-05T13:00:00Z] NTIVE: {broken}\nunfinished",
      );
      const report = await readUsageObservations(input, {
        readAt,
        configuration: acpConfiguration([file]),
      });
      expect(report.rows).toHaveLength(1);
      expect(report.coverage.malformedRecords).toBe(1);
      expect(report.coverage.reasons).toContain("unfinished-record");
    });
  });

  it("bounds line reads and filters the requested local-day window before output caps", async () => {
    await withFile(async (file) => {
      await NodeFSP.writeFile(
        file,
        nativeLine(prompt(), undefined, "2026-10-05T02:00:00Z") +
          nativeLine(prompt({ requestId: "request-2" }), "event-2") +
          nativeLine(prompt({ requestId: "request-3" }), "event-3"),
      );
      const report = await readUsageObservations(
        { ...input, limit: 1 },
        { readAt, configuration: acpConfiguration([file]), maxLines: 2 },
      );
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]?.requestId).toBe("request-2");
      expect(report.coverage.reasons).toContain("scan-budget");
    });
  });

  it("correlates decision native jobs exactly while excluding native and cloud router traffic", async () => {
    await withFile(async (file) => {
      const job = {
        event: "job_finished",
        job_id: "native-job-1",
        source: "otis-decisions",
        job_type: "decision",
        backend_target_kind: "local_llama",
        backend_target_id: "synthetic-backend",
        actual_model: "synthetic-qwen",
        end_time: "2026-10-05T13:00:00Z",
        prompt_tokens: 100,
        completion_tokens: 20,
        token_count: 120,
        prompt_tokens_source: "usage",
      };
      await NodeFSP.writeFile(
        file,
        [
          job,
          { ...job, job_id: "codex-job", source: "codex" },
          { ...job, job_id: "cloud-job", backend_target_kind: "remote_openai_compatible" },
        ]
          .map((value) => JSON.stringify(value))
          .join("\n") + "\n",
      );
      const configuration = JSON.stringify([
        {
          kind: "router",
          sourceId: "synthetic-router",
          files: [file],
          additiveSources: ["otis-decisions"],
        },
        {
          kind: "decisions",
          sourceId: "synthetic-decisions",
          baseUrl: "http://127.0.0.1:5197/",
          actorId: "user:local",
        },
      ]);
      let requests = 0;
      const fetcher = async (url: URL, options: RequestInit) => {
        requests++;
        expect(String(url)).toContain("/api/v1/decisions/usage");
        expect(options?.redirect).toBe("error");
        expect(options?.headers).toEqual({ "X-Otis-Actor": "user:local" });
        return Response.json({
          scope: "retained-actor-decision-attempts",
          partial: false,
          nextCursor: null,
          rows: [
            {
              id: "usage:1",
              batchId: "batch-1",
              providerResponseId: null,
              nativeJobId: "native-job-1",
              model: "synthetic-qwen",
              startedAt: "2026-10-05T13:00:00Z",
              inputTokens: null,
              outputTokens: null,
              reportedCostUsd: null,
              usageState: "unknown",
              taskIds: ["agenda-task:synthetic"],
            },
          ],
        });
      };
      const report = await readUsageObservations(input, { readAt, configuration, fetcher });
      expect(requests).toBe(1);
      expect(report.rows).toHaveLength(2);
      expect(report.rows.find((row) => row.provider === "otis-decisions")).toMatchObject({
        nativeJobId: "native-job-1",
        disposition: "correlationOnly",
      });
      expect(report.rows.find((row) => row.provider === "qwen-router")).toMatchObject({
        nativeJobId: "native-job-1",
        counters: { inputTokens: 100, outputTokens: null },
        recordedOutputTokens: 20,
      });
      expect(report.coverage.excludedNative).toBe(1);
      expect(report.coverage.excludedCloud).toBe(1);
      expect(report).not.toHaveProperty("totals");
    });
  });

  it("rejects query source selection and duplicate configured source identities", async () => {
    await expect(
      readUsageObservations({ ...input, runIds: ["selected"] }, { readAt }),
    ).rejects.toThrow("observation-window-invalid");
    await expect(
      readUsageObservations(input, {
        readAt,
        configuration: JSON.stringify([
          {
            kind: "decisions",
            sourceId: "same",
            baseUrl: "http://127.0.0.1/",
            actorId: "user:local",
          },
          {
            kind: "decisions",
            sourceId: "same",
            baseUrl: "http://127.0.0.1/",
            actorId: "user:local",
          },
        ]),
      }),
    ).rejects.toThrow("observation-source-conflict");
    const report = await readUsageObservations(input, {
      readAt,
      configuration: JSON.stringify([
        {
          kind: "decisions",
          sourceId: "remote",
          baseUrl: "http://remote.invalid/",
          actorId: "user:local",
        },
      ]),
      fetcher: async () => {
        throw new Error("No remote request permitted");
      },
    });
    expect(report.coverage.reasons).toContain("source-unavailable");
  });
});
