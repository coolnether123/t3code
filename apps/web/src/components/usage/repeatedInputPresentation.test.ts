import { describe, expect, it } from "vite-plus/test";
import { UsageDay, type UsageRepeatedInputBreakdown } from "@t3tools/contracts";
import { comparisonGroups, totalTokens } from "./repeatedInputPresentation";

const row: UsageRepeatedInputBreakdown = {
  sourceKind: "skill",
  model: "known",
  project: "project",
  environment: "Desktop",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-01"),
  occurrences: 2,
  sessions: 1,
  turns: 1,
  directTokens: { exact: 10, estimated: 5, cached: 3, cacheWrite: 1, unknown: 1 },
  fullSessionInputTokens: { exact: 90000, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 },
  estimatedApiCostUsd: 0.2,
  priceStatus: "estimated",
};

describe("repeated input comparisons", () => {
  it("adds only direct tokens and retains partial pricing as an incomplete subtotal", () => {
    const [group] = comparisonGroups(
      [row, { ...row, model: null, estimatedApiCostUsd: null, priceStatus: "unpriced" }],
      "source",
    );
    expect(totalTokens(group!.tokens)).toBe(40);
    expect(group).toMatchObject({ occurrences: 4, value: 0.2, incomplete: true });
    const [unknown] = comparisonGroups(
      [{ ...row, estimatedApiCostUsd: null, priceStatus: "unpriced" }],
      "source",
    );
    expect(unknown!.value).toBeNull();
  });

  it("keeps project/environment identities distinct when display names collide", () => {
    const groups = comparisonGroups(
      [
        { ...row, project: "a / b", environment: "c" },
        { ...row, project: "a", environment: "b / c" },
      ],
      "project",
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.key).not.toBe(groups[1]!.key);
  });

  it("bounds long time ranges while retaining every token, occurrence, and value", () => {
    const rows = Array.from({ length: 730 }, (_, index) => {
      const day = UsageDay.make(new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10));
      return { ...row, sinceDay: day, untilDay: day };
    });
    const groups = comparisonGroups(rows.toReversed(), "time");
    expect(groups.length).toBeLessThanOrEqual(48);
    expect(groups[0]!.sinceDay).toBe("2024-01-01");
    expect(groups.reduce((sum, group) => sum + totalTokens(group.tokens), 0)).toBe(14600);
    expect(groups.reduce((sum, group) => sum + group.occurrences, 0)).toBe(1460);
    expect(groups.reduce((sum, group) => sum + (group.value ?? 0), 0)).toBeCloseTo(146);
  });

  it("retains interval ranges without pretending they are daily values", () => {
    const [group] = comparisonGroups([{ ...row, untilDay: UsageDay.make("2026-09-30") }], "time");
    expect(group?.label).toBe("2026-09-01 to 2026-09-30");
    expect(group?.occurrences).toBe(2);
  });
});
