import type { UsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_WEEKLY_KEY,
  limitWindows,
  limitWindowSummary,
  windowSamplesFor,
} from "./usageLimitWindows";

const summary = (fields: Partial<UsageSummary>) => fields as UsageSummary;
const codexSamples = [
  {
    observedAt: "2026-09-28T00:00:00.000Z",
    remainingPercent: 90,
    resetsAt: "2026-10-01T00:00:00.000Z",
  },
  {
    observedAt: "2026-09-28T01:00:00.000Z",
    remainingPercent: 88,
    resetsAt: "2026-10-01T00:00:00.000Z",
  },
];
const sessionSamples = [
  {
    observedAt: "2026-09-28T00:00:00.000Z",
    remainingPercent: 100,
    resetsAt: "2026-09-28T03:00:00.000Z",
  },
  {
    observedAt: "2026-09-28T01:00:00.000Z",
    remainingPercent: 70,
    resetsAt: "2026-09-28T03:00:00.000Z",
  },
];

describe("limitWindows", () => {
  it("lists Codex's weekly limit and each saved Claude window", () => {
    const windows = limitWindows(
      summary({
        quotaHistory: { status: "ready", source: "fixture", message: null, samples: codexSamples },
        providerQuotaHistories: [
          {
            provider: "claude",
            windowId: "five_hour",
            label: "Session",
            kind: "session",
            windowDurationMins: 300,
            status: "ready",
            message: null,
            samples: sessionSamples,
          },
          {
            provider: "claude",
            windowId: "seven_day",
            label: "Weekly",
            kind: "weekly",
            windowDurationMins: 10_080,
            status: "unavailable",
            message: "Sign in",
            samples: [],
          },
        ],
      }),
    );
    expect(windows.map((window) => [window.key, window.status, window.windowMs])).toEqual([
      [CODEX_WEEKLY_KEY, "ready", 7 * 86_400_000],
      ["claude:five_hour", "ready", 5 * 3_600_000],
      ["claude:seven_day", "unavailable", 7 * 86_400_000],
    ]);
    const refreshed = summary({
      quotaHistory: { status: "ready", source: "fixture", message: null, samples: codexSamples },
    });
    expect(windowSamplesFor(CODEX_WEEKLY_KEY)(refreshed)).toBe(codexSamples);
    expect(windowSamplesFor("claude:five_hour")(refreshed)).toBeUndefined();
  });

  it("does not claim a missing history before any summary has arrived", () => {
    expect(limitWindows(null)).toEqual([
      expect.objectContaining({ key: CODEX_WEEKLY_KEY, status: "missing", message: null }),
    ]);
    expect(limitWindows(summary({})).map((window) => window.key)).toEqual([
      CODEX_WEEKLY_KEY,
      "claude:seven_day",
    ]);
  });

  it("paces a session window over five hours, not a week", () => {
    const [, session] = limitWindows(
      summary({
        providerQuotaHistories: [
          {
            provider: "claude",
            windowId: "five_hour",
            label: "Session",
            kind: "session",
            windowDurationMins: 300,
            status: "ready",
            message: null,
            samples: sessionSamples,
          },
        ],
      }),
    );
    const now = Date.parse("2026-09-28T01:00:00.000Z");
    const result = limitWindowSummary(session!, now);
    // Three of five hours have passed, so an even pace would have used 60%; 30% is 30 points ahead.
    expect(result?.remainingPercent).toBe(70);
    expect(result?.resetInMs).toBe(2 * 3_600_000);
    expect(result?.paceDelta).toBeCloseTo(-30, 5);
  });
});
