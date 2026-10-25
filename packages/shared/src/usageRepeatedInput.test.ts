import type { UsageDay, UsageRepeatedInputSummary, UsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeRepeatedInputSummaries } from "./usageRepeatedInput.ts";

const day = "2026-09-13" as UsageDay;
const tokens = (exact: number) => ({ exact, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 });

function repeated(environment: string, occurrences: number): UsageRepeatedInputSummary {
  return {
    items: [
      {
        displayName: "unslop",
        sourceKind: "skill",
        contentHash: "content",
        fileRevisionHash: "revision",
        firstObservedAt: "2026-09-13T10:00:00.000Z",
        lastObservedAt: "2026-09-13T11:00:00.000Z",
        occurrences,
        affectedSessions: occurrences,
        affectedTurns: occurrences,
        confidence: "confirmedPayload",
        confidenceCounts: { reference: 0, likelyRead: 0, confirmedPayload: occurrences },
        directTokens: tokens(10 * occurrences),
        fullSessionInputTokens: tokens(100 * occurrences),
        modelCosts: [
          {
            model: "gpt-test",
            directTokens: tokens(10 * occurrences),
            estimatedApiCostUsd: occurrences,
            priceStatus: "estimated",
            occurrences,
          },
        ],
        breakdowns: [],
      },
    ],
    totals: [
      {
        sourceKind: "skill",
        model: "gpt-test",
        project: "project",
        environment,
        sinceDay: day,
        untilDay: day,
        occurrences,
        sessions: occurrences,
        turns: occurrences,
        directTokens: tokens(10 * occurrences),
        fullSessionInputTokens: tokens(100 * occurrences),
        estimatedApiCostUsd: occurrences,
        priceStatus: "estimated",
      },
    ],
    coverageGaps: [],
    estimatedApiCostUsd: occurrences,
    priceStatus: "estimated",
  };
}

function summary(environment: string, home: string, occurrences: number): UsageSummary {
  return {
    contractVersion: 7,
    readAt: "2026-09-13T12:00:00.000Z",
    timeZone: "UTC",
    sinceDay: day,
    untilDay: day,
    buckets: [],
    sources: [
      {
        fingerprint: {
          hostId: "host",
          provider: "codex",
          resolvedHomePath: home,
          volumeId: `volume:${home}`,
        },
        status: "ok",
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: { status: "fresh", source: "rates", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
    repeatedInput: repeated(environment, occurrences),
  };
}

describe("mergeRepeatedInputSummaries", () => {
  it("combines distinct environments", () => {
    const merged = mergeRepeatedInputSummaries([
      { environmentId: "one", summary: summary("one", "/one", 1) },
      { environmentId: "two", summary: summary("two", "/two", 2) },
    ]);
    expect(merged?.items[0]).toMatchObject({ occurrences: 3, affectedSessions: 3 });
    expect(merged?.estimatedApiCostUsd).toBe(3);
    expect(merged?.totals).toHaveLength(2);
  });

  it("counts an identical physical Codex source once", () => {
    const source = summary("one", "/same", 1);
    const mirrored = { ...summary("two", "/same", 1), sources: source.sources };
    const merged = mergeRepeatedInputSummaries([
      { environmentId: "one", summary: source },
      { environmentId: "two", summary: mirrored },
    ]);
    expect(merged?.items[0]?.occurrences).toBe(1);
    expect(merged?.estimatedApiCostUsd).toBe(1);
  });

  it("keeps a priced subtotal when another environment is unpriced", () => {
    const unpriced = summary("two", "/two", 2);
    const merged = mergeRepeatedInputSummaries([
      { environmentId: "one", summary: summary("one", "/one", 1) },
      {
        environmentId: "two",
        summary: {
          ...unpriced,
          repeatedInput: {
            ...unpriced.repeatedInput!,
            estimatedApiCostUsd: null,
            priceStatus: "unpriced",
          },
        },
      },
    ]);

    expect(merged?.estimatedApiCostUsd).toBe(1);
    expect(merged?.priceStatus).toBe("unpriced");
  });
});
