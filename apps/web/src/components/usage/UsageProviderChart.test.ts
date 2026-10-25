import { PROVIDER_ORDER } from "./usageProviders";
import { describe, expect, it } from "vite-plus/test";

import { buildPeriodColumns } from "./UsageProviderChart";

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 42,
        totalTokens: 420,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
          ["pi" as const, { costUsd: 5, totalTokens: 50 }],
          ["muse" as const, { costUsd: 7, totalTokens: 70 }],
        ]),
      },
    ],
    // 2026-08-02 is deliberately absent: a day with no activity.
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
      },
    ],
  ]);

  it("plots each day on its own", () => {
    expect(buildPeriodColumns(days, byDay, "cost").map((column) => column.total)).toEqual([
      42, 0, 5,
    ]);
  });

  it("reads the requested metric", () => {
    expect(buildPeriodColumns(days, byDay, "tokens").map((column) => column.total)).toEqual([
      420, 0, 50,
    ]);
  });

  it("keeps band values absolute rather than cumulative", () => {
    // Regression: the bands were once stack offsets, which drew Claude Code
    // permanently above Codex regardless of which provider spent more.
    const [first] = buildPeriodColumns(days, byDay, "cost");

    const values = { codex: 10, claude: 20, pi: 5, muse: 7 };
    expect(first?.bands).toEqual(
      PROVIDER_ORDER.map((provider) => ({
        provider,
        value: values[provider as keyof typeof values] ?? 0,
      })),
    );
  });
});
