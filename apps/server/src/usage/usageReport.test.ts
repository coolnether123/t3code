import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  UsageDay,
  UsageReport,
  type UsagePricing,
  type UsageReportInput,
  type UsageSource,
  type UsageSummary,
} from "@t3tools/contracts";

import { makeUsageReportCalculation, projectUsageReport } from "./usageReport.ts";

const pricing: UsagePricing = {
  status: "fresh",
  source: "fixture",
  revision: "a".repeat(64),
  fetchedAt: "2026-08-03T00:00:00.000Z",
  knownModels: 2,
};

const source = (status: UsageSource["status"], sessions: number): UsageSource => ({
  fingerprint: {
    hostId: "fixture-host",
    provider: "codex",
    resolvedHomePath: "C:/fixture/codex",
    volumeId: "1:2",
  },
  status,
  scannedFiles: 2,
  skippedFiles: 1,
  malformedRecords: 0,
  distinctSessions: sessions,
  message: null,
});

const summary: UsageSummary = {
  contractVersion: 7,
  readAt: "2026-08-03T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-02"),
  buckets: [
    {
      day: UsageDay.make("2026-08-01"),
      provider: "codex",
      model: "gpt-5.6-sol",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 10,
        cacheCreationTokens: 0,
        outputTokens: 50,
        reasoningTokens: 5,
      },
      costUsd: 2,
      cacheSavingsUsd: 0.1,
      costSource: "modelPriced",
      records: 2,
      unpricedRecords: 0,
      sessions: 1,
    },
    {
      day: UsageDay.make("2026-08-02"),
      provider: "claude",
      model: "claude-fable-5",
      totals: {
        uncachedInputTokens: 20,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: 1,
      unpricedRecords: 1,
      sessions: 1,
    },
    {
      day: UsageDay.make("2026-08-02"),
      hourStart: "2026-08-02T01:00:00.000Z",
      provider: "codex",
      model: "gpt-5.6-sol",
      totals: {
        uncachedInputTokens: 30,
        cachedInputTokens: 0,
        cacheCreationTokens: 2,
        outputTokens: 12,
        reasoningTokens: 1,
      },
      costUsd: 1,
      cacheSavingsUsd: 0.2,
      costSource: "providerReported",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    },
  ],
  sources: [source("ok", 2), source("partial", 1)],
  pricing,
  scanDurationMs: 12,
  quotaHistory: {
    status: "ready",
    source: "fixture",
    samples: [
      {
        observedAt: "2026-08-01T00:00:00.000Z",
        remainingPercent: 90,
        resetsAt: "2026-08-08T00:00:00.000Z",
      },
      {
        observedAt: "2026-08-02T00:00:00.000Z",
        remainingPercent: 80,
        resetsAt: "2026-08-08T00:00:00.000Z",
      },
    ],
    message: null,
  },
  quotaCostSnapshots: [
    {
      intervalId: "reset-1",
      fingerprint: source("ok", 1).fingerprint,
      sinceTime: "2026-08-01T00:00:00.000Z",
      untilTime: "2026-08-02T00:00:00.000Z",
      costUsd: 3,
      records: 3,
      recordedAt: "2026-08-02T00:01:00.000Z",
      firstRemainingPercent: 90,
      lastRemainingPercent: 80,
      resetsAt: "2026-08-08T00:00:00.000Z",
    },
  ],
};

const runSummary: UsageSummary = {
  ...summary,
  buckets: [
    {
      ...summary.buckets[0]!,
      runId: "run-a",
      firstActivityAt: "2026-08-01T10:00:00.000Z",
      lastActivityAt: "2026-08-01T10:15:00.000Z",
    },
    {
      ...summary.buckets[2]!,
      model: "gpt-5.7-sol",
      runId: "run-a",
      firstActivityAt: "2026-08-02T11:00:00.000Z",
      lastActivityAt: "2026-08-02T11:05:00.000Z",
    },
    {
      ...summary.buckets[0]!,
      runId: "run-b",
      records: 1,
      firstActivityAt: "2026-08-01T12:00:00.000Z",
      lastActivityAt: "2026-08-01T12:00:00.000Z",
    },
    summary.buckets[1]!,
  ],
};

const input = (mode: UsageReportInput["mode"], limit?: number): UsageReportInput => ({
  mode,
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-02"),
  timeZone: "UTC",
  ...(limit === undefined ? {} : { limit }),
});

const calculation = makeUsageReportCalculation(pricing, {
  "gpt-5.6-sol": {
    inputCostPerMillionTokens: 1,
    outputCostPerMillionTokens: 2,
  },
});
const decodeUsageReport = Schema.decodeUnknownSync(UsageReport);

describe("agent usage report projections", () => {
  it("returns complete overall totals while preserving partial coverage", () => {
    const report = projectUsageReport(summary, input("overview"), calculation);
    expect(report).toMatchObject({
      mode: "overview",
      coverage: {
        status: "partial",
        records: 4,
        pricedRecords: 3,
        unpricedRecords: 1,
        distinctSessions: 3,
      },
      totals: {
        costUsd: 3,
        records: 4,
        pricedRecords: 3,
        unpricedRecords: 1,
        sessions: 3,
      },
    });
    expect(report.calculation.priceOverrides).toHaveLength(1);
    expect(report.calculation.costBasis).toBe("apiEquivalent");
    expect(decodeUsageReport(report)).toEqual(report);
  });

  it("caps provider/model rows and marks truncation", () => {
    const providers = projectUsageReport(summary, input("providers", 1), calculation);
    const models = projectUsageReport(summary, input("models", 1), calculation);
    if (providers.mode !== "providers" || models.mode !== "models") throw new Error("wrong mode");
    expect(providers).toMatchObject({ mode: "providers", totalRows: 2, truncated: true });
    expect(providers.rows).toHaveLength(1);
    expect(models).toMatchObject({ mode: "models", totalRows: 2, truncated: true });
    expect(models.rows).toHaveLength(1);
    expect(models.rows[0]?.provider).toBe("codex");
  });

  it("rolls buckets into a bounded day/hour series", () => {
    const daily = projectUsageReport(summary, input("series", 1), calculation);
    if (daily.mode !== "series") throw new Error("wrong mode");
    expect(daily).toMatchObject({
      mode: "series",
      resolution: "day",
      totalPoints: 2,
      truncated: true,
    });
    expect(daily.points).toHaveLength(1);
    expect(daily.points[0]?.day).toBe(UsageDay.make("2026-08-02"));

    const hourlySummary: UsageSummary = {
      ...summary,
      buckets: summary.buckets
        .filter((bucket) => bucket.provider === "codex")
        .map((bucket, index) => ({
          ...bucket,
          hourStart: index === 0 ? "2026-08-02T00:00:00.000Z" : "2026-08-02T01:00:00.000Z",
        })),
    };
    const hourly = projectUsageReport(
      hourlySummary,
      { ...input("series"), resolution: "hour" },
      calculation,
    );
    if (hourly.mode !== "series") throw new Error("wrong mode");
    expect(hourly.points).toHaveLength(2);
    expect(hourly.points[1]?.hourStart).toBe("2026-08-02T01:00:00.000Z");
  });

  it("returns bounded quota history and durable reset costs", () => {
    const report = projectUsageReport(summary, input("quota", 1), calculation);
    if (report.mode !== "quota") throw new Error("wrong mode");
    expect(report).toMatchObject({
      mode: "quota",
      samplesTruncated: true,
      totalSamples: 2,
      totalCosts: 1,
      costsTruncated: false,
    });
    expect(report.quotaHistory.samples).toHaveLength(1);
    expect(report.quotaHistory.samples[0]?.remainingPercent).toBe(80);
    expect(report.costs[0]).toMatchObject({
      intervalId: "reset-1",
      costUsd: 3,
      firstRemainingPercent: 90,
      lastRemainingPercent: 80,
      resetsAt: "2026-08-08T00:00:00.000Z",
    });
  });

  it("groups all model buckets by exact run and keeps activity and pricing coverage", () => {
    const report = projectUsageReport(runSummary, input("runs"), calculation);
    if (report.mode !== "runs") throw new Error("wrong mode");

    expect(report).toMatchObject({
      mode: "runs",
      totalRuns: 2,
      truncated: false,
      totalDailyRuns: 3,
      dailyRunsTruncated: false,
      totalDailyUnattributed: 1,
      dailyUnattributedTruncated: false,
      runCoverage: {
        status: "partial",
        records: 5,
        attributedRecords: 4,
        unattributedRecords: 1,
        distinctRuns: 2,
      },
      unattributed: [
        {
          provider: "claude",
          records: 1,
          unpricedRecords: 1,
          totals: { outputTokens: 10 },
        },
      ],
    });
    expect(report.runs[0]).toMatchObject({
      provider: "codex",
      runId: "run-a",
      threadId: null,
      threadMapping: "unavailable",
      models: ["gpt-5.6-sol", "gpt-5.7-sol"],
      totalModels: 2,
      firstActivityAt: "2026-08-01T10:00:00.000Z",
      lastActivityAt: "2026-08-02T11:05:00.000Z",
      records: 3,
      pricedRecords: 3,
      unpricedRecords: 0,
      costUsd: 3,
      pricingCoverage: "complete",
    });
    expect(report.dailyRuns).toMatchObject([
      {
        day: "2026-08-02",
        provider: "codex",
        runId: "run-a",
        records: 1,
        threadMapping: "unavailable",
      },
      {
        day: "2026-08-01",
        provider: "codex",
        runId: "run-a",
        records: 2,
        threadMapping: "unavailable",
      },
      {
        day: "2026-08-01",
        provider: "codex",
        runId: "run-b",
        records: 1,
        threadMapping: "unavailable",
      },
    ]);
    expect(report.dailyUnattributed).toMatchObject([
      { day: "2026-08-02", provider: "claude", records: 1 },
    ]);
    expect(report.dailyRuns[0]!.costUsd + report.dailyRuns[1]!.costUsd).toBe(
      report.runs[0]!.costUsd,
    );
    expect(decodeUsageReport(report)).toEqual(report);
    expect(report.calculation.costBasis).toBe("apiEquivalent");
  });

  it("filters to exact run IDs and leaves the row limit explicit", () => {
    const selected = projectUsageReport(
      runSummary,
      { ...input("runs"), runIds: ["run-b"] },
      calculation,
    );
    const limited = projectUsageReport(runSummary, input("runs", 1), calculation);
    if (selected.mode !== "runs" || limited.mode !== "runs") throw new Error("wrong mode");

    expect(selected.runs.map((run) => run.runId)).toEqual(["run-b"]);
    expect(selected.dailyRuns.map((run) => run.runId)).toEqual(["run-b"]);
    expect(selected.dailyUnattributed).toEqual([]);
    expect(selected.unattributed).toEqual([]);
    expect(selected.runCoverage).toMatchObject({
      status: "filtered",
      records: 1,
      attributedRecords: 1,
      unattributedRecords: 0,
      distinctRuns: 1,
    });
    expect(limited).toMatchObject({ totalRuns: 2, truncated: true });
    expect(limited).toMatchObject({
      totalDailyRuns: 3,
      dailyRunsTruncated: true,
      totalDailyUnattributed: 1,
      dailyUnattributedTruncated: false,
    });
    expect(limited.runs).toHaveLength(1);
    expect(limited.runs[0]?.runId).toBe("run-a");
    expect(limited.unattributed).toHaveLength(1);
  });
});
