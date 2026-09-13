/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { UsageDay, type UsageRepeatedInputSummary } from "@t3tools/contracts";

import { RepeatedInputSection } from "./RepeatedInputSection";

const directTokens = { exact: 40, estimated: 5, cached: 10, cacheWrite: 2, unknown: 1 };
const fullSessionInputTokens = {
  exact: 700,
  estimated: 100,
  cached: 80,
  cacheWrite: 10,
  unknown: 10,
};
const breakdown = {
  sourceKind: "skill" as const,
  model: "gpt-5.6-luna",
  project: "worktree",
  environment: "Desktop",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-02"),
  occurrences: 3,
  sessions: 2,
  turns: 3,
  directTokens,
  fullSessionInputTokens,
  estimatedApiCostUsd: 0.12,
  priceStatus: "estimated" as const,
};
const repeatedInput: UsageRepeatedInputSummary = {
  items: [
    {
      displayName: "unslop",
      sourceKind: "skill",
      contentHash: "sha256-abcdefghijklmnopqrstuvwxyz",
      fileRevisionHash: "sha256-revision-123",
      firstObservedAt: "2026-09-01T12:00:00.000Z",
      lastObservedAt: "2026-09-02T12:00:00.000Z",
      occurrences: 3,
      affectedSessions: 2,
      affectedTurns: 3,
      confidence: "confirmedPayload",
      confidenceCounts: { reference: 0, likelyRead: 1, confirmedPayload: 2 },
      directTokens,
      fullSessionInputTokens,
      modelCosts: [
        {
          model: "gpt-5.6-luna",
          directTokens,
          estimatedApiCostUsd: 0.12,
          priceStatus: "estimated",
          occurrences: 3,
        },
      ],
      breakdowns: [breakdown],
    },
  ],
  totals: [breakdown],
  coverageGaps: [
    {
      reason: "malformed",
      count: 1,
      message: "One malformed transcript record was retained as unknown.",
    },
  ],
  estimatedApiCostUsd: 0.12,
  priceStatus: "estimated",
};

afterEach(() => vi.unstubAllGlobals());

describe("RepeatedInputSection", () => {
  it("renders additive direct totals and keeps overlapping session context out of the overview", () => {
    const markup = renderToStaticMarkup(<RepeatedInputSection data={repeatedInput} />);

    expect(markup).toContain("Repeated input");
    expect(markup).toContain("Direct payload input");
    expect(markup).not.toContain("Full affected session input");
    expect(markup).toContain("Confirmed payload");
    expect(markup).toContain(
      'aria-label="Direct token composition: Exact 40, Estimated 5, Cached 10, Cache-write 2, Unknown 1"',
    );
    expect(markup).toContain("$0.12");
    expect(markup).toContain("By source kind");
    expect(markup).toContain("By project/environment");
    expect(markup).not.toContain("Codex usage &amp; resets");
  });

  it("shows a priced subtotal when part of the input has no price", () => {
    const markup = renderToStaticMarkup(
      <RepeatedInputSection data={{ ...repeatedInput, priceStatus: "unpriced" }} />,
    );
    expect(markup).toContain("API-equivalent priced subtotal");
    expect(markup).toContain("$0.12");
    expect(markup).toContain("Pricing is incomplete");
  });

  it("reveals evidence and per-model attribution on demand", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RepeatedInputSection data={repeatedInput} />));
      const details = container.querySelector<HTMLButtonElement>(
        '[aria-label="Details for unslop"]',
      )!;
      expect(container.textContent).not.toContain("Full affected session input");
      await act(async () => details.click());
      expect(details.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("Full affected session input 900");
      expect(container.textContent).toContain("input totals overlap");
      expect(container.textContent).toContain("sha256-abcdefghijklmnopqrstuvwxyz");
      expect(container.textContent).toContain("File revision/hash");
      expect(container.querySelector("table")?.textContent).toContain("gpt-5.6-luna58$0.12");
      await act(async () => details.click());
      expect(container.querySelector("table")).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("switches comparison dimensions and metrics with selectable time periods", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RepeatedInputSection data={repeatedInput} />));
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "By model")!
          .click(),
      );
      expect(
        container.querySelector('[aria-label="Repeated input comparison chart"]')?.textContent,
      ).toContain("gpt-5.6-luna");
      const metric = container.querySelector<HTMLSelectElement>(
        '[aria-label="Repeated input comparison metric"]',
      )!;
      await act(async () => {
        metric.value = "value";
        metric.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(
        container.querySelector('[aria-label="Repeated input comparison chart"]')?.textContent,
      ).toContain("$0.12");
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Over time")!
          .click(),
      );
      const bar = container.querySelector<HTMLButtonElement>(
        '[aria-label="Repeated input over time"] button',
      )!;
      expect(bar.getAttribute("aria-label")).toBe("2026-09-01 to 2026-09-02: $0.12");
      await act(async () => bar.click());
      expect(bar.getAttribute("aria-pressed")).toBe("true");
      expect(container.textContent).toContain("interval totals are not daily rates");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("bounds a large revision list, searches beyond the first page, and clears filters", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const items = Array.from({ length: 2072 }, (_, index) => ({
      ...repeatedInput.items[0]!,
      displayName: `Skill ${index}`,
      contentHash: `hash-${index}`,
    }));
    try {
      await act(async () =>
        root.render(<RepeatedInputSection data={{ ...repeatedInput, items }} />),
      );
      expect(container.querySelectorAll('[aria-label^="Details for"]')).toHaveLength(12);
      expect(container.textContent).toContain("1 to 12 of 2,072 payloads");
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Next payloads"]')!.click(),
      );
      expect(container.textContent).toContain("13 to 24 of 2,072 payloads");
      const input = container.querySelector<HTMLInputElement>(
        '[aria-label="Search repeated payloads"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "hash-2071",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.querySelectorAll('[aria-label^="Details for"]')).toHaveLength(1);
      expect(container.textContent).toContain("Skill 2071");
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Clear filters")!
          .click(),
      );
      expect(container.querySelectorAll('[aria-label^="Details for"]')).toHaveLength(12);
      const evidence = container.querySelector<HTMLSelectElement>(
        '[aria-label="Payload evidence"]',
      )!;
      await act(async () => {
        evidence.value = "reference";
        evidence.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.textContent).toContain("No payloads match these filters");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps missing prices unpriced instead of displaying a free value", () => {
    const markup = renderToStaticMarkup(
      <RepeatedInputSection
        data={{
          totals: [],
          items: [
            {
              displayName: "AGENTS.md",
              sourceKind: "instruction",
              contentHash: "sha256-agents",
              fileRevisionHash: null,
              firstObservedAt: "2026-09-01T12:00:00.000Z",
              lastObservedAt: "2026-09-01T12:00:00.000Z",
              occurrences: 1,
              affectedSessions: 1,
              affectedTurns: 1,
              confidence: "reference",
              confidenceCounts: { reference: 1, likelyRead: 0, confirmedPayload: 0 },
              directTokens,
              fullSessionInputTokens,
              modelCosts: [
                {
                  model: "future-unknown-model",
                  directTokens,
                  estimatedApiCostUsd: null,
                  priceStatus: "unpriced",
                  occurrences: 1,
                },
              ],
              breakdowns: [],
            },
          ],
          coverageGaps: [],
          estimatedApiCostUsd: null,
          priceStatus: "unpriced",
        }}
      />,
    );

    expect(markup).toContain("Unpriced");
    expect(markup).not.toContain("$0.00");
    expect(markup).toContain("Unknown models and missing prices stay unpriced");
  });

  it("shows coverage gaps without requiring a repeated payload", () => {
    const markup = renderToStaticMarkup(
      <RepeatedInputSection
        data={{
          items: [],
          totals: [],
          coverageGaps: [
            {
              reason: "unattributed",
              count: 4,
              message: "Four records could not be assigned to one payload.",
            },
            {
              reason: "oversized",
              count: 1,
              message: "Transcript too large to inspect safely.",
            },
          ],
          estimatedApiCostUsd: null,
          priceStatus: "unpriced",
        }}
      />,
    );

    expect(markup).toContain("Coverage and unknown-attribution gaps");
    expect(markup).toContain("4 observations could not be attributed");
    expect(markup).toContain("Transcript too large to inspect safely.");
    expect(markup).toContain("No repeated payload was confirmed");
  });
});
