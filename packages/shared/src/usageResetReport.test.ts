import { describe, expect, it } from "vite-plus/test";
import type { UsageQuotaCostSnapshot } from "@t3tools/contracts";
import { cleanResetLedger, resetHistoryPlan, subscriptionPayments } from "./usageResetReport.ts";

const row = (start: string, end: string, costUsd: number, home = "/home/a", intervalId = start): UsageQuotaCostSnapshot => ({
  intervalId, sinceTime: start, untilTime: end, costUsd, records: 10,
  fingerprint: { hostId: "host", provider: "codex", resolvedHomePath: home, volumeId: "disk" },
  recordedAt: "2026-10-25T00:00:00Z", firstRemainingPercent: 100, lastRemainingPercent: 14, resetsAt: end,
});
describe("reset value history", () => {
  it("drops comparison rows, stale ends and contained windows before summing homes", () => {
    const start = "2026-09-01T00:00:00Z";
    const end = "2026-09-08T00:00:00Z";
    const result = cleanResetLedger([
      row(start, "2026-09-07T00:00:00Z", 1000),
      row(start, "2026-09-07T00:00:00Z", 500, "/home/c"),
      row(start, end, 100), row(start, end, 20, "/home/b"),
      row("2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z", 800),
      row(start, end, 9000, "/home/a", "api-pace:test"),
      row(start, end, 9000, "/home/a", "compare:test"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.costUsd).toBe(120);
    expect(result[0]?.sources).toHaveLength(2);
  });
  it("splits unrecorded July usage and later gaps at public resets", () => {
    const saved = [row("2026-08-30T00:00:00Z", "2026-09-17T00:00:00Z", 500), row("2026-09-19T00:00:00Z", "2026-09-20T00:00:00Z", 80)];
    const plan = resetHistoryPlan(saved, "2026-07-01T00:00:00Z", "2026-09-21T00:00:00Z", ["2026-07-08T00:00:00Z", "2026-09-18T00:00:00Z"]);
    const gaps = plan.flatMap((window) => window.missing);
    expect(gaps.map((gap) => [gap.sinceTime, gap.untilTime])).toEqual([
      ["2026-07-01T00:00:00.000Z", "2026-07-08T00:00:00.000Z"],
      ["2026-07-08T00:00:00.000Z", "2026-08-30T00:00:00.000Z"],
      ["2026-09-17T00:00:00.000Z", "2026-09-18T00:00:00.000Z"],
      ["2026-09-18T00:00:00.000Z", "2026-09-19T00:00:00.000Z"],
      ["2026-09-20T00:00:00.000Z", "2026-09-21T00:00:00.000Z"],
    ]);
    const filled = gaps.map((gap) => ({ ...row(gap.sinceTime, gap.untilTime, 10, "/home/a", gap.id), estimatedFromTranscripts: true }));
    const complete = resetHistoryPlan([...saved, ...filled], "2026-07-01T00:00:00Z", "2026-09-21T00:00:00Z", ["2026-07-08T00:00:00Z", "2026-09-18T00:00:00Z"]);
    expect(complete.flatMap((window) => window.missing)).toEqual([]);
    expect(complete.reduce((sum, window) => sum + window.costUsd, 0)).toBe(630);
  });
  it("counts monthly payments on the chosen billing day, clamping short months", () => {
    expect(subscriptionPayments("2026-07-01", 200, "2026-10-25T00:00:00Z").reduce((sum, payment) => sum + payment.paidUsd, 0)).toBe(800);
    expect(subscriptionPayments("2026-07-31", 200, "2026-10-25T00:00:00Z")).toHaveLength(3);
    expect(subscriptionPayments("2026-01-31", 200, "2026-02-28T20:00:00Z")).toHaveLength(2);
  });
});
