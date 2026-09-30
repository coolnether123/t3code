import { UsageDay, UsageReport, type UsageReportInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  PromptUsageAccumulator,
  promptUsageTimeBounds,
  validatePromptUsageInput,
} from "./usagePromptReport.ts";

const input: UsageReportInput = {
  mode: "prompts",
  sinceDay: UsageDay.make("2026-09-29"),
  untilDay: UsageDay.make("2026-09-29"),
  timeZone: "America/Chicago",
};
const message = (text: string, id = "a", createdAt = "2026-09-29T12:00:00.000Z") => ({
  messageId: id,
  threadId: "thread",
  createdAt,
  text,
  textLength: Array.from(text).length,
});
const now = "2026-09-30T04:00:00.000Z";
const decodeReport = Schema.decodeUnknownSync(UsageReport);

describe("persisted prompt usage", () => {
  it("deduplicates IDs in a changing read and filters digit-bearing word runs", () => {
    const accumulator = new PromptUsageAccumulator(input);
    accumulator.add(message("gpt-4o claude-3.5-sonnet"));
    accumulator.add(message("changed text", "a"));
    const report = accumulator.report(now);
    expect(report.totals.prompts).toBe(1);
    expect(report.coverage.status).toBe("partial");
    expect(report.words.map((row) => row.word).sort()).toEqual(["claude", "gpt", "sonnet"]);
    expect(report.totals.words).toBe(6);
  });
  it("counts repeat submissions and Unicode words, not tokens", () => {
    const accumulator = new PromptUsageAccumulator(input);
    accumulator.add(message("The café build build 123 👋"));
    accumulator.add(message("The café build build 123 👋", "b"));
    accumulator.add(message("", "attachment-only"));
    const report = accumulator.report(now);
    expect(report.totals).toMatchObject({ prompts: 3, words: 10, threads: 1, activeDays: 1 });
    expect(report.words).toEqual([
      { word: "build", count: 4 },
      { word: "café", count: 2 },
    ]);
    expect(decodeReport(report)).toEqual(report);
    expect(report).not.toHaveProperty("calculation");
    expect(JSON.stringify(report)).not.toContain("👋");
  });

  it("filters exact half-open instants and local day boundaries", () => {
    const accumulator = new PromptUsageAccumulator({
      ...input,
      sinceTime: "2026-09-29T06:00:00Z",
      untilTime: "2026-09-30T04:00:00Z",
    });
    accumulator.add(message("before", "a", "2026-09-29T05:59:59Z"));
    accumulator.add(message("included", "b", "2026-09-29T06:00:00Z"));
    accumulator.add(message("excluded", "c", "2026-09-30T04:00:00Z"));
    expect(accumulator.report(now).totals.prompts).toBe(1);
    expect(promptUsageTimeBounds(input)).toEqual({
      sinceTime: "2026-09-29T05:00:00.000Z",
      untilTime: "2026-09-30T05:00:00.000Z",
    });
  });

  it("uses 23-hour and 25-hour local days across DST changes", () => {
    for (const [day, hours] of [
      ["2026-03-08", 23],
      ["2026-11-01", 25],
    ] as const) {
      const bounds = promptUsageTimeBounds({
        ...input,
        sinceDay: UsageDay.make(day),
        untilDay: UsageDay.make(day),
      });
      expect(Date.parse(bounds.untilTime) - Date.parse(bounds.sinceTime)).toBe(hours * 3600000);
    }
  });

  it("qualifies missing and truncated text without inventing word averages", () => {
    const accumulator = new PromptUsageAccumulator(input);
    accumulator.add({ ...message("short"), textLength: 40000 });
    const report = accumulator.report(now);
    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.truncatedMessages).toBe(1);
    expect(report.totals).toMatchObject({ prompts: 1, words: 0, averageWordsPerPrompt: null });
    expect(new PromptUsageAccumulator(input).report(now, true).coverage.status).toBe("missing");
    expect(new PromptUsageAccumulator(input).report(now).coverage.status).toBe("complete");
  });

  it("caps word output without changing counts", () => {
    const accumulator = new PromptUsageAccumulator({ ...input, limit: 1 });
    accumulator.add(message("zebra build build alpha"));
    const report = accumulator.report(now);
    expect(report.words).toEqual([{ word: "build", count: 2 }]);
    expect(report.countedDistinctWords).toBe(3);
    expect(report.wordsTruncated).toBe(true);
    expect(report.totals.words).toBe(4);
  });

  it("rejects invalid or unsupported query fields", () => {
    for (const patch of [
      { timeZone: "bad" },
      { sinceDay: UsageDay.make("2026-02-30") },
      { providers: ["codex" as const] },
      { resolution: "hour" as const },
      { sinceTime: "2026-09-29T01:00:00Z" },
      { sinceDay: UsageDay.make("2024-01-01") },
    ]) {
      expect(() => validatePromptUsageInput({ ...input, ...patch })).toThrow();
    }
    expect(() => validatePromptUsageInput(input)).not.toThrow();
  });
});
