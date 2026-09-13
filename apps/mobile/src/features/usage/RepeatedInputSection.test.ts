import { describe, expect, it, vi } from "vite-plus/test";
import { UsageDay, type UsageRepeatedInputSummary } from "@t3tools/contracts";

vi.mock("react-native", () => ({ Pressable: "Pressable", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../settings/components/SettingsSection", () => ({ SettingsSection: "Section" }));
import { normalizeRepeatedInput } from "./RepeatedInputSection";

const directTokens = { exact: 12, estimated: 2, cached: 4, cacheWrite: 0, unknown: 0 };
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
const summary: UsageRepeatedInputSummary = {
  items: [
    {
      displayName: "unslop",
      sourceKind: "skill",
      contentHash: "hash-one",
      fileRevisionHash: null,
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
    },
  ],
  totals: [breakdown],
  coverageGaps: [],
  estimatedApiCostUsd: 0.2,
  priceStatus: "estimated",
};

describe("mobile repeated input presentation", () => {
  it("reads the contract and keeps overlapping session input only on each payload", () => {
    const view = normalizeRepeatedInput({
      ...summary,
      items: [summary.items[0]!, { ...summary.items[0]!, contentHash: "hash-two" }],
    });
    expect(view).toMatchObject({ itemCount: 2, occurrences: 4, direct: { exact: 24, cached: 8 } });
    expect(view).not.toHaveProperty("fullSession");
    expect(view?.items[0]).toMatchObject({
      fullSession: 700,
      project: "project / Desktop",
      models: [{ model: "luna", valueUsd: 0.2, priced: true }],
    });
    expect(view?.models[0]).toMatchObject({ count: 2, tokens: 18, valueUsd: 0.2 });
  });
  it("retains a mixed priced subtotal and marks it incomplete", () => {
    const view = normalizeRepeatedInput({
      ...summary,
      priceStatus: "unpriced",
      totals: [{ ...breakdown, priceStatus: "unpriced" }],
    });
    expect(view).toMatchObject({ valueUsd: 0.2, valuePriced: false });
    expect(view?.models[0]).toMatchObject({ valueUsd: 0.2, priced: false });
  });
  it("keeps unknown-only pricing null and tolerates older environments without data", () => {
    const view = normalizeRepeatedInput({
      ...summary,
      items: [],
      totals: [{ ...breakdown, model: null, estimatedApiCostUsd: null, priceStatus: "unpriced" }],
      estimatedApiCostUsd: null,
      priceStatus: "unpriced",
    });
    expect(view?.models[0]).toMatchObject({
      label: "Unknown model",
      valueUsd: null,
      priced: false,
    });
    expect(view?.valueUsd).toBeNull();
    expect(normalizeRepeatedInput(undefined)).toBeNull();
  });
});
