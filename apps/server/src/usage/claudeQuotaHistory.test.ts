import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  appendClaudeQuotaReadings,
  claudeQuotaHistories,
  decodeClaudeQuotaHistory,
  emptyClaudeQuotaHistory,
  markClaudeQuotaUnavailable,
} from "./claudeQuotaHistory.ts";

const HOUR = 60 * 60 * 1000;
const start = Date.parse("2026-09-28T00:00:00.000Z");
const weekly = (usedPercent: number, resetsAt = "2026-10-01T08:00:00.000Z") =>
  ({
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 10_080,
    usedPercent,
    resetsAt,
  }) satisfies ServerProviderUsageWindow;

describe("claudeQuotaHistory", () => {
  it("keeps the start and latest confirmation of a flat stretch", () => {
    let history = emptyClaudeQuotaHistory;
    for (const minute of [0, 5, 10, 15]) {
      history = appendClaudeQuotaReadings(history, [weekly(20)], start + minute * 60_000);
    }
    history = appendClaudeQuotaReadings(history, [weekly(24)], start + 20 * 60_000);
    const [window] = claudeQuotaHistories(history);
    expect(window?.samples.map((sample) => [sample.observedAt, sample.remainingPercent])).toEqual([
      ["2026-09-28T00:00:00.000Z", 80],
      ["2026-09-28T00:15:00.000Z", 80],
      ["2026-09-28T00:20:00.000Z", 76],
    ]);
  });

  it("still records an unchanged reading every hour", () => {
    let history = emptyClaudeQuotaHistory;
    for (let step = 0; step <= 30; step++) {
      history = appendClaudeQuotaReadings(history, [weekly(10)], start + step * 5 * 60_000);
    }
    const samples = claudeQuotaHistories(history)[0]?.samples ?? [];
    expect(samples.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < samples.length; index++) {
      const gap =
        Date.parse(samples[index]!.observedAt) - Date.parse(samples[index - 1]!.observedAt);
      expect(gap).toBeLessThanOrEqual(HOUR);
    }
  });

  it("treats a new reset time as a change and skips windows without one", () => {
    let history = appendClaudeQuotaReadings(emptyClaudeQuotaHistory, [weekly(90)], start);
    history = appendClaudeQuotaReadings(
      history,
      [
        weekly(0, "2026-10-08T08:00:00.000Z"),
        { ...weekly(5), id: "five_hour", kind: "session", label: "Session", resetsAt: undefined },
      ],
      start + 60_000,
    );
    const windows = claudeQuotaHistories(history);
    expect(windows.map((window) => window.windowId)).toEqual(["seven_day"]);
    expect(windows[0]?.samples.map((sample) => sample.resetsAt)).toEqual([
      "2026-10-01T08:00:00.000Z",
      "2026-10-08T08:00:00.000Z",
    ]);
  });

  it("orders session windows before weekly ones and survives a JSON round trip", () => {
    const history = appendClaudeQuotaReadings(
      emptyClaudeQuotaHistory,
      [
        weekly(12),
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 40,
          resetsAt: "2026-09-28T03:00:00.000Z",
        },
      ],
      start,
    );
    const decoded = decodeClaudeQuotaHistory(JSON.parse(JSON.stringify(history)));
    expect(decoded).toEqual(history);
    expect(claudeQuotaHistories(decoded).map((window) => window.windowId)).toEqual([
      "five_hour",
      "seven_day",
    ]);
  });

  it("reports why no reading exists without dropping saved ones", () => {
    const failed = markClaudeQuotaUnavailable(emptyClaudeQuotaHistory, "Sign in", start);
    expect(claudeQuotaHistories(failed)[0]).toMatchObject({
      status: "unavailable",
      message: "Sign in",
      samples: [],
    });
    const saved = appendClaudeQuotaReadings(emptyClaudeQuotaHistory, [weekly(30)], start);
    const later = markClaudeQuotaUnavailable(saved, "Offline", start + HOUR);
    expect(claudeQuotaHistories(later)[0]).toMatchObject({ status: "ready", message: "Offline" });
    expect(claudeQuotaHistories(later)[0]?.samples).toHaveLength(1);
  });

  it("reads malformed documents as empty", () => {
    expect(decodeClaudeQuotaHistory({ version: 2, windows: {} })).toEqual(emptyClaudeQuotaHistory);
    expect(
      decodeClaudeQuotaHistory({
        version: 1,
        windows: { seven_day: { label: "Weekly", kind: "weekly", samples: [[1, 200, 5], "x"] } },
      }).windows.seven_day?.samples,
    ).toEqual([]);
  });
});
