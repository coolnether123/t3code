// @effect-diagnostics globalDate:off -- Fixture timestamps are fixed.
import type { UsageQuotaSample } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  moveWorkCallout,
  parentShares,
  PLANS,
  planOutlook,
  planRunOutTime,
  planUsageDays,
} from "./usagePlanOutlook.ts";

const now = Date.parse("2026-11-25T09:35:00Z");
const day = 86_400_000;
const iso = (value: number) => new Date(value).toISOString();
const samples = (initial: number, remaining: number, reset: string): UsageQuotaSample[] => [
  { observedAt: iso(now - day), remainingPercent: initial, resetsAt: reset },
  { observedAt: iso(now), remainingPercent: remaining, resetsAt: reset },
];
const claude = samples(31, 24, "2026-11-26T08:00:00.000Z");
const codex = samples(84, 58, "2026-11-30T20:01:00.000Z");
const gemini = samples(45.5, 37.6, "2026-11-30T20:17:00.000Z");

it("forecasts the plans independently and finds Claude's spare room", () => {
  const normal = planOutlook(claude, now, "claude");
  const warning = planOutlook(codex, now, "codex");
  const smoothing = planOutlook(gemini, now, "gemini");
  if (
    normal.status !== "leftover" ||
    warning.status !== "runsOut" ||
    smoothing.status !== "runsOut"
  ) {
    throw new Error("Expected three forecasts");
  }
  expect(Math.round(normal.hoursLeft)).toBe(82);
  expect(Math.floor(normal.unused)).toBe(17);
  expect(Math.round(warning.hoursLeft)).toBe(54);
  expect(planRunOutTime(warning.runsOutAt, now)).toBe("Fri 9 AM");
  expect(Math.round(warning.multiple * 100)).toBe(41);
  expect(Math.round(smoothing.hoursLeft)).toBe(114);
  expect(planRunOutTime(smoothing.runsOutAt, now)).toBe("Sun 9:30 PM");
  expect(
    moveWorkCallout([
      { plan: PLANS[0], outlook: normal },
      { plan: PLANS[1], outlook: warning },
      { plan: PLANS[2], outlook: smoothing },
    ]),
  ).toMatchObject({ short: { plan: { id: "codex" } }, spare: { plan: { id: "claude" } } });
});

it.each([
  [undefined, now, "loading"],
  [[], now, "missing"],
  [claude, now + 16 * 60_000, "stale"],
  [samples(5, 0, "2026-11-26T08:00:00.000Z"), now, "exhausted"],
  [samples(25, 25, "2026-11-26T08:00:00.000Z"), now, "noPace"],
] as const)("reflects quota availability and freshness (%#)", (readings, clock, status) => {
  expect(planOutlook(readings, clock, "claude").status).toBe(status);
});

it("omits a lane with any partial day and preserves the unallocated share", () => {
  const row = (lane: string, costUsd: number | null, complete = true) => ({
    lane,
    period: "2026-11-25",
    provider: "claude-code",
    usage: { costUsd, complete, records: 1 },
  });
  expect(
    parentShares(
      [row("a", 20), row("b", 70), row("b", null, false)],
      PLANS[0],
      100,
      new Map([
        ["a", "RimWorld"],
        ["b", "Sheltered"],
      ]),
    ),
  ).toEqual({ parents: [{ lane: "a", name: "RimWorld", share: 0.2 }], other: 0.8, partial: true });
  expect(planUsageDays(Date.parse("2026-11-25T03:00:00Z"))).toMatchObject({
    sinceDay: "2026-11-23",
    untilDay: "2026-11-24",
  });
});
