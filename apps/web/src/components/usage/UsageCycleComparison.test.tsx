/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { quotaPeriods } from "@t3tools/shared/usageQuota";
import type { UsageSummaryInput } from "@t3tools/contracts";
const state = vi.hoisted(() => ({ usage: vi.fn(), missing: false }));
vi.mock("../../state/usage", () => ({
  useUsage: (input: UsageSummaryInput) => state.usage(input),
}));
import { UsageCycleComparison } from "./UsageCycleComparison";

const samples = [1, 2, 3].flatMap((day) =>
  [0, 2].map((hour) => ({
    observedAt: `2026-09-0${day}T0${hour}:00:00.000Z`,
    resetsAt: `2026-09-${day + 10}T00:00:00.000Z`,
    remainingPercent: 100 - hour * day,
  })),
);
const periods = quotaPeriods(samples);
const fingerprint = {
  hostId: "pc",
  provider: "codex",
  resolvedHomePath: "/sessions",
  volumeId: "1",
};
beforeEach(() => {
  state.missing = false;
  state.usage.mockReset().mockImplementation((input: UsageSummaryInput) => ({
    isPending: false,
    refresh: vi.fn(),
    environments: [
      {
        environmentId: "pc",
        isPending: false,
        error: null,
        summary: {
          sources: [{ fingerprint, status: "ok" }],
          quotaCosts: input.quotaIntervals?.map((interval, index) => ({
            intervalId: interval.id,
            fingerprint,
            complete: !state.missing,
            unpricedRecords: 0,
            models: [
              {
                model: "gpt-6-astra",
                costUsd: index ? 20 : 10,
                unpricedRecords: 0,
                totals: {
                  uncachedInputTokens: 20,
                  cachedInputTokens: 80,
                  cacheCreationTokens: 0,
                  outputTokens: 100,
                  reasoningTokens: 50,
                },
              },
            ],
          })),
        },
      },
    ],
  }));
});

describe("cycle comparison controls", () => {
  it("loads costs on expansion, switches any older cycle, and collapses without changing the selected chart cycle", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <UsageCycleComparison
            period={periods[2]!}
            periods={periods}
            samples={samples}
            selectedIds={["pc"]}
          />,
        ),
      );
      expect(container.textContent).toContain("2.0 points more quota used");
      expect(state.usage).not.toHaveBeenCalled();
      const toggle = container.querySelector("button")!;
      await act(async () => toggle.click());
      expect(container.querySelector('[aria-label="Cycle insights"]')?.textContent).toContain(
        "100% more",
      );
      expect(
        container.querySelector('[aria-label="Cycle cost comparison"]')?.textContent,
      ).toContain("80.0%");
      const select = container.querySelector("select")!;
      expect(select.options).toHaveLength(2);
      await act(async () => {
        select.value = periods[0]!.id;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.textContent).toContain("4.0 points more quota used");
      const input = state.usage.mock.lastCall![0] as UsageSummaryInput;
      expect(input.quotaIntervals?.[0]?.sinceTime).toBe(periods[0]!.first.observedAt);
      expect(input.quotaIntervals?.[1]?.sinceTime).toBe(periods[2]!.first.observedAt);
      await act(async () => toggle.click());
      expect(container.querySelector("select")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
  it("withholds cost conclusions when either interval is incomplete or a selected computer is missing", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      state.missing = true;
      await act(async () =>
        root.render(
          <UsageCycleComparison
            period={periods[2]!}
            periods={periods}
            samples={samples}
            selectedIds={["pc"]}
          />,
        ),
      );
      await act(async () => container.querySelector("button")!.click());
      expect(container.textContent).toContain("Complete priced transcripts are unavailable");
      expect(container.querySelector('[aria-label="Cycle insights"]')).toBeNull();
      state.missing = false;
      await act(async () =>
        root.render(
          <UsageCycleComparison
            period={periods[2]!}
            periods={periods}
            samples={samples}
            selectedIds={["pc", "offline"]}
          />,
        ),
      );
      expect(container.querySelector('[aria-label="Cycle insights"]')).toBeNull();
      expect(
        container.querySelector('[aria-label="Quota used over equal recorded time"]'),
      ).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
