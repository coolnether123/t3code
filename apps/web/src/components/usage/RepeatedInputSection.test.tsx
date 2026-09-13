/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  UsageDay,
  type UsageRepeatedInputCatalogItem,
  type UsageRepeatedInputSummary,
} from "@t3tools/contracts";

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

const unobservedSkill: UsageRepeatedInputCatalogItem = {
  displayName: "installed-only",
  sourceKind: "skill",
  contentHash: "sha256-installed-only",
  fileRevisionHash: "revision-installed-only",
  byteLength: null,
  tokenCount: null,
  observed: false,
  firstObservedAt: null,
  lastObservedAt: null,
  occurrences: 0,
  affectedSessions: 0,
  affectedTurns: 0,
  confidence: null,
  confidenceCounts: { reference: 0, likelyRead: 0, confirmedPayload: 0 },
  directTokens: { exact: 0, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 },
  fullSessionInputTokens: { exact: 0, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 },
  modelCosts: [],
  breakdowns: [],
  estimatedApiCostUsd: null,
  priceStatus: "unpriced",
};
const observedSkill: UsageRepeatedInputCatalogItem = {
  ...repeatedInput.items[0]!,
  contentHash: "sha256-current-unslop",
  observed: true,
  byteLength: 2048,
  tokenCount: 512,
  estimatedApiCostUsd: 0.12,
  priceStatus: "estimated",
};

afterEach(() => vi.unstubAllGlobals());

describe("RepeatedInputSection", () => {
  it("shows current skills without observations and retains historical payload revisions", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <RepeatedInputSection
            data={{ ...repeatedInput, catalog: [unobservedSkill, observedSkill] }}
          />,
        ),
      );
      const catalog = container.querySelector(
        '[aria-labelledby="repeated-input-catalog-heading"]',
      )!;
      expect(catalog.textContent).toContain("Current skill catalog");
      expect(catalog.textContent).toContain("installed-only");
      expect(catalog.textContent).toContain("2,048 bytes");
      expect(catalog.textContent).toContain("512 content tokens");
      expect(
        container.querySelector(
          '[aria-labelledby="repeated-input-payloads-heading"] [aria-label="Details for unslop"]',
        ),
      ).not.toBeNull();
      const neverObserved = catalog.querySelector<HTMLButtonElement>(
        '[aria-label="Catalog details for installed-only"]',
      )!;
      await act(async () => neverObserved.click());
      const row = neverObserved.parentElement!;
      expect(row.textContent).toContain("Never observed in this period");
      expect(row.textContent).toContain("Unknown file size");
      expect(row.textContent).toContain("Unknown token size");
      expect(row.textContent).toContain("No observation evidence");
      expect(row.textContent).toContain("No direct input was observed");
      expect(row.textContent).toContain("Unpriced. No observed model input to price.");
      expect(row.textContent).toContain("revision-installed-only");
      expect(row.textContent).not.toContain("$0.00");
      expect(row.textContent).not.toContain("1970");
      expect(row.textContent).not.toContain("Invalid Date");
      expect(row.querySelector('[aria-label^="Direct token composition"]')).toBeNull();
      await act(async () =>
        catalog
          .querySelector<HTMLButtonElement>('[aria-label="Catalog details for unslop"]')!
          .click(),
      );
      expect(catalog.textContent).toContain("sha256-current-unslop");
      expect(catalog.textContent).toContain("Observed in this period");
      expect(catalog.textContent).toContain("Price stateEstimated");
      expect(
        catalog.querySelector(
          '[aria-label="Direct token composition: Exact 40, Estimated 5, Cached 10, Cache-write 2, Unknown 1"]',
        ),
      ).not.toBeNull();
      expect(catalog.querySelector("table")?.textContent).toContain("gpt-5.6-luna58$0.12");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("paginates and searches all catalog revisions and filters observation status", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const catalog = [
      observedSkill,
      ...Array.from({ length: 36 }, (_, index) => ({
        ...unobservedSkill,
        displayName: `Skill ${String(index).padStart(2, "0")}`,
        contentHash: `catalog-hash-${index}`,
      })),
    ];
    try {
      await act(async () =>
        root.render(<RepeatedInputSection data={{ ...repeatedInput, catalog }} />),
      );
      expect(container.querySelectorAll('[aria-label^="Catalog details for"]')).toHaveLength(12);
      expect(container.textContent).toContain("1 to 12 of 37 skill revisions");
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Next skill revisions"]')!.click(),
      );
      expect(container.textContent).toContain("13 to 24 of 37 skill revisions");
      const input = container.querySelector<HTMLInputElement>(
        '[aria-label="Search skill catalog"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "catalog-hash-35",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.querySelectorAll('[aria-label^="Catalog details for"]')).toHaveLength(1);
      expect(container.textContent).toContain("Skill 35");
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Clear catalog filters")!
          .click(),
      );
      const status = container.querySelector<HTMLSelectElement>(
        '[aria-label="Skill observation status"]',
      )!;
      await act(async () => {
        status.value = "observed";
        status.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.querySelectorAll('[aria-label^="Catalog details for"]')).toHaveLength(1);
      expect(container.querySelector('[aria-label="Catalog details for unslop"]')).not.toBeNull();
      await act(async () => {
        status.value = "unobserved";
        status.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(container.textContent).toContain("1 to 12 of 36 skill revisions");
      expect(container.querySelector('[aria-label="Catalog details for unslop"]')).toBeNull();
      expect(container.querySelector('[aria-label="Details for unslop"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps separate file revisions with identical content independently expandable", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <RepeatedInputSection
            data={{
              ...repeatedInput,
              catalog: [
                { ...unobservedSkill, fileRevisionHash: "revision-one" },
                { ...unobservedSkill, fileRevisionHash: "revision-two" },
              ],
            }}
          />,
        ),
      );
      const rows = container.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Catalog details for installed-only"]',
      );
      expect(rows).toHaveLength(2);
      await act(async () => rows[1]!.click());
      expect(rows[1]!.getAttribute("aria-expanded")).toBe("true");
      const input = container.querySelector<HTMLInputElement>(
        '[aria-label="Search skill catalog"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "revision-one",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(
        container.querySelectorAll('[aria-label="Catalog details for installed-only"]'),
      ).toHaveLength(1);
      expect(
        container
          .querySelector('[aria-label="Catalog details for installed-only"]')
          ?.getAttribute("aria-expanded"),
      ).toBe("false");
    } finally {
      await act(async () => root.unmount());
    }
  });

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

  it("offers a touch-sized period selector for dense timelines", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <RepeatedInputSection
            data={{
              ...repeatedInput,
              totals: [
                breakdown,
                {
                  ...breakdown,
                  sinceDay: UsageDay.make("2026-09-03"),
                  untilDay: UsageDay.make("2026-09-04"),
                },
              ],
            }}
          />,
        ),
      );
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Over time")!
          .click(),
      );
      const periods = container.querySelector<HTMLSelectElement>(
        '[aria-label="Repeated input time period"]',
      )!;
      await act(async () => {
        periods.value = periods.options[1]!.value;
        periods.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(
        container
          .querySelector('[aria-label="Repeated input over time"] [aria-pressed="true"]')
          ?.getAttribute("aria-label"),
      ).toContain("2026-09-03 to 2026-09-04");
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
