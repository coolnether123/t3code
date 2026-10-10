import {
  OtisPromptReport,
  UsageDay,
  UsageReportPrompts,
  type UsageReportInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { readOtisPromptReport, selectPromptReport } from "./otisPromptSubscriber.ts";
import { validPromptCutoverReceipt } from "./promptSubscriberState.ts";

const decodeLocalReport = Schema.decodeUnknownSync(UsageReportPrompts);

const input: UsageReportInput = {
  mode: "prompts",
  sinceDay: UsageDay.make("2026-10-10"),
  untilDay: UsageDay.make("2026-10-10"),
  timeZone: "UTC",
  keyword: "chrome",
};
const report: OtisPromptReport = {
  schemaVersion: 1,
  authority: "Otis:usage-analytics",
  sourceId: "t3-local",
  countingPolicy: "unicode-runs-nfkc-v1",
  readAt: "2026-10-10T08:00:00.000Z",
  window: {
    ...input,
    sinceTime: "2026-10-10T00:00:00.000Z",
    untilTime: "2026-10-11T00:00:00.000Z",
  },
  status: "available",
  freshness: {
    status: "current",
    sourceObservedAt: "2026-10-10T08:00:00.000Z",
    ageMs: 0,
    revision: 1,
  },
  coverage: {
    status: "complete",
    examinedMessages: 2,
    countedMessages: 2,
    sourceMessages: 2,
    truncatedMessages: 0,
    reasons: [],
  },
  totals: {
    prompts: 2,
    words: 3,
    characters: 18,
    threads: 1,
    activeDays: 1,
    averageWordsPerPrompt: 1.5,
  },
  daily: [{ day: UsageDay.make("2026-10-10"), prompts: 2, words: 3 }],
  words: [
    { word: "chrome", count: 2 },
    { word: "build", count: 1 },
  ],
  keyword: { word: "chrome", count: 2, prompts: 2 },
  countedDistinctWords: 2,
  wordsTruncated: false,
};
const local: UsageReportPrompts = {
  ...input,
  contractVersion: 1,
  mode: "prompts",
  readAt: report.readAt,
  scope: "t3UserMessages",
  coverage: {
    status: "complete",
    examinedMessages: 2,
    countedMessages: 2,
    truncatedMessages: 0,
    reasons: [],
  },
  totals: report.totals!,
  daily: report.daily,
  words: report.words,
  keyword: report.keyword,
  countedDistinctWords: 2,
  wordsTruncated: false,
  countingPolicy: "Retained T3 policy.",
};
const env = {
  T3_OTIS_USAGE_ORIGIN: "http://127.0.0.1:5197",
  T3_OTIS_USAGE_TOKEN: "synthetic-read-token",
};

describe("Otis prompt subscriber compatibility", () => {
  it("accepts producer v1 and additive fields over authenticated bounded HTTP", async () => {
    const actual = await readOtisPromptReport(input, env, async (url, options) => {
      expect(String(url)).toBe("http://127.0.0.1:5197/api/v1/usage-analytics/report");
      expect(options?.redirect).toBe("error");
      expect(options?.headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer synthetic-read-token" }),
      );
      expect(JSON.parse(String(options?.body)).keyword).toBe("chrome");
      return Response.json({ ...report, additive: true });
    });
    const selected = selectPromptReport(input, actual, local);
    expect(decodeLocalReport(selected).analytics?.authority).toBe("Otis");
    expect(selected.analytics?.parity).toBe("matched");
  });
  it.each([
    { schemaVersion: 2 },
    { countingPolicy: "other-policy" },
    { sourceId: "other" },
    { window: { ...report.window, timeZone: "America/Chicago" } },
    { keyword: { word: "other", count: 2, prompts: 1 } },
  ])("rejects incompatible or wrongly scoped producer %j", async (change) => {
    await expect(
      readOtisPromptReport(input, env, async () => Response.json({ ...report, ...change })),
    ).rejects.toThrow();
  });
  it("handles a missing service and reconnects on the next read", async () => {
    await expect(
      readOtisPromptReport(input, env, async () => new Response(null, { status: 503 })),
    ).rejects.toThrow();
    expect(selectPromptReport(input, null, local).analytics?.reason).toBe("otis-unavailable");
    const reconnected = await readOtisPromptReport(input, env, async () => Response.json(report));
    expect(selectPromptReport(input, reconnected, local).analytics?.authority).toBe("Otis");
  });
  it("keeps local results for partial and stale Otis data", () => {
    const partial = {
      ...report,
      status: "partial" as const,
      coverage: { ...report.coverage, status: "partial" as const, reasons: ["index-warming"] },
    };
    expect(selectPromptReport(input, partial, local).analytics?.reason).toBe("otis-index-partial");
    const stale = { ...report, freshness: { ...report.freshness, status: "stale" as const } };
    expect(selectPromptReport(input, stale, local).analytics?.reason).toBe("otis-stale");
  });
  it("reports wrong rankings and counts without returning misleading parity", () => {
    const ranked = selectPromptReport(
      input,
      { ...report, words: report.words.toReversed() },
      local,
    );
    expect(ranked.analytics?.parity).toBe("mismatch");
    expect(ranked.analytics?.differences).toEqual(["words"]);
    const counted = selectPromptReport(
      input,
      { ...report, totals: { ...report.totals!, prompts: 3 } },
      local,
    );
    expect(counted.analytics?.differences).toContain("totals");
    expect(counted.totals.prompts).toBe(2);
  });
  it("missing history stays missing and old producers remain compatible", () => {
    const old = decodeLocalReport(local);
    expect(old.analytics).toBeUndefined();
    const missing = {
      ...report,
      status: "unavailable" as const,
      coverage: { ...report.coverage, status: "missing" as const },
      totals: null,
    };
    const selected = selectPromptReport(input, missing, {
      ...local,
      coverage: { ...local.coverage, status: "missing" },
    });
    expect(selected.coverage.status).toBe("missing");
    expect(selected.analytics?.authority).toBe("T3-fallback");
  });
  it("fails closed on response bounds and nonlocal origins", async () => {
    await expect(
      readOtisPromptReport(input, env, async () => new Response("x".repeat(4 * 1024 * 1024 + 1))),
    ).rejects.toThrow("limit");
    await expect(
      readOtisPromptReport(input, { ...env, T3_OTIS_USAGE_ORIGIN: "http://example.test" }),
    ).rejects.toThrow("configuration");
  });
  it("requires a passing contract-compatible no-drift receipt before stopping local recomputation", () => {
    const proof = {
      schemaVersion: 1,
      reportContractVersion: 1,
      countingPolicy: "unicode-runs-nfkc-v1",
      sourceDrift: false,
      matched: true,
      windows: [{ matched: true }],
    };
    expect(validPromptCutoverReceipt(proof)).toBe(true);
    for (const change of [
      { matched: false },
      { sourceDrift: true },
      { reportContractVersion: 2 },
      { windows: [] },
      { windows: [{ matched: false }] },
    ])
      expect(validPromptCutoverReceipt({ ...proof, ...change })).toBe(false);
  });
});
