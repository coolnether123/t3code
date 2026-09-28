import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { quotaPeriods } from "@t3tools/shared/usageQuota";

import { modelTrackerData, UsageModelTracker } from "./UsageModelTracker";
import type { ChartActivity } from "./usageChartActivity";

const at = (hour: number) =>
  new Date(Date.parse("2026-09-01T00:00:00Z") + hour * 3_600_000).toISOString();
const samples = [
  { observedAt: at(0), remainingPercent: 90, resetsAt: at(168) },
  { observedAt: at(1), remainingPercent: 86, resetsAt: at(168) },
  { observedAt: at(2), remainingPercent: 82, resetsAt: at(168) },
];
const period = quotaPeriods(samples)[0]!;
const totals = {
  uncachedInputTokens: 100,
  cachedInputTokens: 50,
  cacheCreationTokens: 0,
  outputTokens: 25,
  reasoningTokens: 10,
};
const models = [
  { model: "gpt-6-astra", costUsd: 30, totals, unpricedRecords: 0 },
  { model: "gpt-6-sol", costUsd: 10, totals, unpricedRecords: 0 },
];
const activity: ChartActivity[] = [
  {
    interval: { id: "first", sinceTime: at(0), untilTime: at(1) },
    models: [
      { ...models[0]!, costUsd: 10 },
      { ...models[1]!, costUsd: 5 },
    ],
  },
  {
    interval: { id: "second", sinceTime: at(1), untilTime: at(2) },
    models: [
      { ...models[0]!, costUsd: 20 },
      { ...models[1]!, costUsd: 5 },
    ],
  },
];

describe("model tracker", () => {
  it("allocates observed quota points by priced model activity without double counting reasoning", () => {
    const result = modelTrackerData(period, samples, models, activity);
    expect(result.rows[0]?.estimatedPoints).toBeCloseTo(4 * (10 / 15) + 4 * (20 / 25));
    expect(result.rows[1]?.estimatedPoints).toBeCloseTo(4 * (5 / 15) + 4 * (5 / 25));
    expect(result.rows.reduce((sum, row) => sum + (row.estimatedPoints ?? 0), 0)).toBeCloseTo(8);
    const markup = renderToStaticMarkup(
      <UsageModelTracker
        period={period}
        samples={samples}
        models={models}
        activity={activity}
        scope="Desktop"
      />,
    );
    expect(markup).toContain("≈ 5.9 pts");
    expect(markup).toContain("≈ 2.1 pts");
    expect(markup).toContain("175 tokens");
    expect(markup).toContain("one pooled quota");
    expect(markup).toContain('role="img"');
  });

  it("does not draw a timed curve from missing or mismatched intervals", () => {
    expect(modelTrackerData(period, samples, models, [activity[0]!]).points).toBeNull();
    expect(
      modelTrackerData(period, samples, models, [{ ...activity[0]!, models: null }, activity[1]!])
        .points,
    ).toBeNull();
    expect(
      modelTrackerData(period, samples, models, [
        activity[0]!,
        { ...activity[1]!, models: [{ ...models[0]!, costUsd: 1 }] },
      ]).points,
    ).toBeNull();
    const markup = renderToStaticMarkup(
      <UsageModelTracker
        period={period}
        samples={samples}
        models={null}
        activity={[]}
        scope="Desktop"
      />,
    );
    expect(markup).toContain("No quota share is inferred");
    expect(markup).not.toContain('role="img"');
  });

  it("leaves a quota drop with no priced activity unattributed", () => {
    const result = modelTrackerData(
      period,
      samples,
      [
        { ...models[0]!, costUsd: 20 },
        { ...models[1]!, costUsd: 5 },
      ],
      [{ ...activity[0]!, models: [] }, activity[1]!],
    );
    expect(result.unattributed).toBe(4);
    expect(result.rows.map((row) => row.estimatedPoints)).toEqual([3.2, 0.8]);
  });
});
