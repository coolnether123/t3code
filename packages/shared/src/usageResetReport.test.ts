import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { UsageQuotaCostSnapshot } from "@t3tools/contracts";
import { cleanResetLedger, resetHistoryPlan, subscriptionPayments } from "./usageResetReport.ts";

const row = (
  start: string,
  end: string,
  costUsd: number,
  home = "/home/a",
  intervalId = start,
): UsageQuotaCostSnapshot => ({
  intervalId,
  sinceTime: start,
  untilTime: end,
  costUsd,
  records: 10,
  fingerprint: { hostId: "host", provider: "codex", resolvedHomePath: home, volumeId: "disk" },
  recordedAt: "2026-10-25T00:00:00Z",
  firstRemainingPercent: 100,
  lastRemainingPercent: 14,
  resetsAt: end,
});
describe("reset value history", () => {
  it.each([
    ["2026-10-20T06:35:31.371Z", "2026-10-22T10:05:31.352Z", 99],
    ["2026-10-22T10:05:31.352Z", "2026-10-22T17:10:37.048Z", 50],
    ["2026-10-23T17:45:30.629Z", "2026-10-25T06:10:31.050Z", 82],
    ["2026-10-25T06:10:31.050Z", "2026-10-25T12:20:00Z", 44],
  ])("retains priced usage when an empty home has a later end: %s", (start, end) => {
    const paid = row(
      start,
      DateTime.formatIso(DateTime.makeUnsafe(Date.parse(end) - 300_000)),
      676.97,
    );
    const empty = { ...row(start, end, 0, "/home/empty"), records: 0 };
    expect(resetHistoryPlan([paid, empty], start, end, [])[0]?.costUsd).toBe(676.97);
    expect(
      resetHistoryPlan([paid, { ...empty, fingerprint: paid.fingerprint }], start, end, [])[0]
        ?.costUsd,
    ).toBe(676.97);
  });
  it.each([
    ["2026-10-13T05:00:00Z", "2026-10-13T05:06:00Z"],
    ["2026-10-11T04:00:00Z", "2026-10-11T04:01:00Z"],
  ])("prefers a sampled reset to its nearby public announcement: %s", (announcement, reset) => {
    const start = "2026-10-10T00:00:00Z";
    const samples = [
      { observedAt: start, remainingPercent: 10, resetsAt: reset },
      { observedAt: reset, remainingPercent: 100, resetsAt: "2026-10-20T00:00:00Z" },
    ];
    const plan = resetHistoryPlan([], start, "2026-10-14T00:00:00Z", [announcement], samples);
    expect(plan).toHaveLength(2);
    expect(plan[1]?.sinceTime).toBe(DateTime.formatIso(DateTime.makeUnsafe(reset)));
  });
  it("does not invent an ending percentage across an unobserved gap", () => {
    const saved = row("2026-09-01T00:00:00Z", "2026-09-06T00:00:00Z", 100);
    const next = row("2026-09-08T00:00:00Z", "2026-09-09T00:00:00Z", 20);
    const plan = resetHistoryPlan([saved, next], saved.sinceTime, "2026-09-10T00:00:00Z", []);
    expect(plan[0]?.remainingPercent).toBeNull();
    const gap = plan[0]!.missing[0]!;
    const estimated = {
      ...row(gap.sinceTime, gap.untilTime, 10, "/home/a", gap.id),
      estimatedFromTranscripts: true,
    };
    expect(
      resetHistoryPlan([saved, next, estimated], saved.sinceTime, "2026-09-10T00:00:00Z", [])[0]
        ?.estimatedFromTranscripts,
    ).toBe(true);
  });
  it("discards a premature gap estimate overlapping observed windows", () => {
    const observed = row("2026-08-30T00:00:00Z", "2026-09-06T00:00:00Z", 100);
    const premature = {
      ...row("2026-08-29T00:00:00Z", "2026-09-05T00:00:00Z", 900),
      estimatedFromTranscripts: true,
    };
    expect(cleanResetLedger([observed, premature]).map((window) => window.costUsd)).toEqual([100]);
  });
  it("prices a changed subscription start inside an observed window", () => {
    const observed = row("2026-07-01T00:00:00Z", "2026-07-08T00:00:00Z", 100);
    const plan = resetHistoryPlan([observed], "2026-07-03T00:00:00Z", "2026-07-08T00:00:00Z", []);
    const gap = plan[0]!.missing[0]!;
    const filled = {
      ...row(gap.sinceTime, gap.untilTime, 60, "/home/a", gap.id),
      estimatedFromTranscripts: true,
    };
    const result = resetHistoryPlan(
      [observed, filled],
      "2026-07-03T00:00:00Z",
      "2026-07-08T00:00:00Z",
      [],
    );
    expect(result[0]?.costUsd).toBe(60);
    expect(result[0]?.missing).toEqual([]);
  });
  it("splits an unpriced period at an observed tracker reset and retains the end percentage", () => {
    const samples = [
      {
        observedAt: "2026-07-01T00:00:00Z",
        remainingPercent: 100,
        resetsAt: "2026-07-08T00:00:00Z",
      },
      {
        observedAt: "2026-07-03T23:59:00Z",
        remainingPercent: 14,
        resetsAt: "2026-07-08T00:00:00Z",
      },
      {
        observedAt: "2026-07-04T00:00:00Z",
        remainingPercent: 100,
        resetsAt: "2026-07-11T00:00:00Z",
      },
    ];
    const plan = resetHistoryPlan([], "2026-07-01T00:00:00Z", "2026-07-05T00:00:00Z", [], samples);
    expect(plan).toHaveLength(2);
    expect(plan[0]?.remainingPercent).toBe(14);
    expect(plan[0]?.untilTime).toBe("2026-07-04T00:00:00.000Z");
  });
  it("drops comparison rows, stale ends and contained windows before summing homes", () => {
    const start = "2026-09-01T00:00:00Z";
    const end = "2026-09-08T00:00:00Z";
    const result = cleanResetLedger([
      row(start, "2026-09-07T00:00:00Z", 1000),
      row(start, "2026-09-07T00:00:00Z", 500, "/home/c"),
      row(start, end, 100),
      row(start, end, 20, "/home/b"),
      row("2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z", 800),
      row(start, end, 9000, "/home/a", "api-pace:test"),
      row(start, end, 9000, "/home/a", "compare:test"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.costUsd).toBe(120);
    expect(result[0]?.sources).toHaveLength(2);
  });
  it("splits unrecorded July usage and later gaps at public resets", () => {
    const saved = [
      row("2026-08-30T00:00:00Z", "2026-09-17T00:00:00Z", 500),
      row("2026-09-19T00:00:00Z", "2026-09-20T00:00:00Z", 80),
    ];
    const plan = resetHistoryPlan(saved, "2026-07-01T00:00:00Z", "2026-09-21T00:00:00Z", [
      "2026-07-08T00:00:00Z",
      "2026-09-18T00:00:00Z",
    ]);
    const gaps = plan.flatMap((window) => window.missing);
    expect(gaps.map((gap) => [gap.sinceTime, gap.untilTime])).toEqual([
      ["2026-07-01T00:00:00.000Z", "2026-07-08T00:00:00.000Z"],
      ["2026-07-08T00:00:00.000Z", "2026-08-30T00:00:00.000Z"],
      ["2026-09-17T00:00:00.000Z", "2026-09-18T00:00:00.000Z"],
      ["2026-09-18T00:00:00.000Z", "2026-09-19T00:00:00.000Z"],
      ["2026-09-20T00:00:00.000Z", "2026-09-21T00:00:00.000Z"],
    ]);
    const filled = gaps.map((gap) => ({
      ...row(gap.sinceTime, gap.untilTime, 10, "/home/a", gap.id),
      estimatedFromTranscripts: true,
    }));
    const complete = resetHistoryPlan(
      [...saved, ...filled],
      "2026-07-01T00:00:00Z",
      "2026-09-21T00:00:00Z",
      ["2026-07-08T00:00:00Z", "2026-09-18T00:00:00Z"],
    );
    expect(complete.flatMap((window) => window.missing)).toEqual([]);
    expect(complete.reduce((sum, window) => sum + window.costUsd, 0)).toBe(630);
  });
  it("counts monthly payments on the chosen billing day, clamping short months", () => {
    expect(
      subscriptionPayments("2026-07-01", 200, "2026-10-25T00:00:00Z").reduce(
        (sum, payment) => sum + payment.paidUsd,
        0,
      ),
    ).toBe(800);
    expect(subscriptionPayments("2026-07-31", 200, "2026-10-25T00:00:00Z")).toHaveLength(3);
    expect(subscriptionPayments("2026-01-31", 200, "2026-02-28T20:00:00Z")).toHaveLength(2);
  });
});
