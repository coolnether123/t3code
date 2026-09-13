import { describe, expect, it, vi } from "vite-plus/test";
import {
  UsageDay,
  type UsageRepeatedInputCatalogItem,
  type UsageRepeatedInputSummary,
} from "@t3tools/contracts";

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("../settings/components/SettingsSection", () => ({ SettingsSection: "Section" }));

import {
  filterRepeatedInputRows,
  normalizeRepeatedInput,
  paginateRepeatedInputRows,
  priceText,
} from "./RepeatedInputSection";

const directTokens = { exact: 12, estimated: 2, cached: 4, cacheWrite: 3, unknown: 1 };
const emptyTokens = { exact: 0, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 };
const fullSessionInputTokens = { exact: 700, estimated: 0, cached: 0, cacheWrite: 0, unknown: 0 };
const breakdown = {
  sourceKind: "skill" as const,
  model: "luna",
  project: "project",
  environment: "Desktop",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-02"),
  occurrences: 2,
  sessions: 1,
  turns: 2,
  directTokens,
  fullSessionInputTokens,
  estimatedApiCostUsd: 0.2,
  priceStatus: "estimated" as const,
};

function catalogItem(
  overrides: Partial<UsageRepeatedInputCatalogItem> = {},
): UsageRepeatedInputCatalogItem {
  return {
    displayName: "unslop",
    sourceKind: "skill",
    contentHash: "hash-current",
    fileRevisionHash: "revision-current",
    byteLength: 1024,
    tokenCount: 64,
    observed: true,
    firstObservedAt: "2026-09-01T00:00:00Z",
    lastObservedAt: "2026-09-02T00:00:00Z",
    occurrences: 2,
    affectedSessions: 1,
    affectedTurns: 2,
    confidence: "confirmedPayload",
    confidenceCounts: { reference: 0, likelyRead: 0, confirmedPayload: 2 },
    directTokens,
    fullSessionInputTokens,
    modelCosts: [
      {
        model: "luna",
        directTokens,
        estimatedApiCostUsd: 0.2,
        priceStatus: "estimated",
        occurrences: 2,
      },
    ],
    breakdowns: [breakdown],
    estimatedApiCostUsd: 0.2,
    priceStatus: "estimated",
    ...overrides,
  };
}

const summary: UsageRepeatedInputSummary = {
  items: [
    {
      displayName: "unslop",
      sourceKind: "skill",
      contentHash: "hash-old",
      fileRevisionHash: "revision-old",
      firstObservedAt: "2026-08-31T00:00:00Z",
      lastObservedAt: "2026-09-01T00:00:00Z",
      occurrences: 2,
      affectedSessions: 1,
      affectedTurns: 2,
      confidence: "confirmedPayload",
      confidenceCounts: { reference: 0, likelyRead: 0, confirmedPayload: 2 },
      directTokens,
      fullSessionInputTokens,
      modelCosts: [
        {
          model: "luna",
          directTokens,
          estimatedApiCostUsd: 0.2,
          priceStatus: "estimated",
          occurrences: 2,
        },
      ],
      breakdowns: [breakdown],
    },
  ],
  catalog: [
    catalogItem(),
    catalogItem({
      displayName: "unused-skill",
      contentHash: "hash-never",
      fileRevisionHash: null,
      byteLength: 2048,
      tokenCount: null,
      observed: false,
      firstObservedAt: null,
      lastObservedAt: null,
      occurrences: 0,
      affectedSessions: 0,
      affectedTurns: 0,
      confidence: null,
      confidenceCounts: { reference: 0, likelyRead: 0, confirmedPayload: 0 },
      directTokens: emptyTokens,
      fullSessionInputTokens: emptyTokens,
      modelCosts: [],
      breakdowns: [],
      estimatedApiCostUsd: null,
      priceStatus: "unpriced",
    }),
  ],
  totals: [breakdown],
  coverageGaps: [],
  estimatedApiCostUsd: 0.2,
  priceStatus: "estimated",
};

describe("mobile repeated input presentation", () => {
  it("keeps current catalog revisions separate from historical observations", () => {
    const view = normalizeRepeatedInput(summary);
    expect(view).toMatchObject({
      catalogAvailable: true,
      catalogCount: 2,
      itemCount: 1,
      occurrences: 2,
      direct: { exact: 12, estimated: 2, cached: 4, cacheWrite: 3, unknown: 1 },
    });
    expect(view?.catalog[0]).toMatchObject({
      name: "unslop",
      observed: true,
      byteLength: 1024,
      tokenCount: 64,
      first: "2026-09-01T00:00:00Z",
      confidenceLevel: "Confirmed payload",
    });
    expect(view?.catalog[1]).toMatchObject({
      name: "unused-skill",
      observed: false,
      first: null,
      last: null,
      confidenceLevel: null,
      tokenCount: null,
      estimatedApiCostUsd: null,
      priceStatus: "unpriced",
    });
    expect(view?.items[0]).toMatchObject({
      contentHash: "hash-old",
      revisionHash: "revision-old",
      observed: true,
      fullSessionTokens: fullSessionInputTokens,
    });
  });

  it("searches, filters never-observed skills, and sorts by installed size", () => {
    const view = normalizeRepeatedInput(summary)!;
    const rows = filterRepeatedInputRows(view.catalog, {
      status: "never",
      sort: "size",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "unused-skill", observed: false });
    expect(filterRepeatedInputRows(view.catalog, { query: "revision-current" })[0]?.name).toBe(
      "unslop",
    );
    expect(filterRepeatedInputRows(view.catalog, { query: "not-present" })).toHaveLength(0);
  });

  it("bounds catalog and history rendering with deterministic pages", () => {
    const rows = Array.from({ length: 25 }, (_, index) => index);
    expect(paginateRepeatedInputRows(rows, 0, 12)).toMatchObject({
      page: 0,
      pageCount: 3,
      items: rows.slice(0, 12),
    });
    expect(paginateRepeatedInputRows(rows, 4, 12)).toMatchObject({
      page: 2,
      items: rows.slice(24),
    });
  });

  it("shows unknown prices explicitly instead of implying a free value", () => {
    expect(priceText(null, "unpriced")).toBe("Unpriced (price unavailable)");
    expect(priceText(0.2, "unpriced")).toContain("priced subtotal");
    expect(priceText(null, "unpriced")).not.toContain("$0.00");
    expect(normalizeRepeatedInput(undefined)).toBeNull();
  });
});
