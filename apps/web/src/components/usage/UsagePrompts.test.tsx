import { EnvironmentId, UsageDay, type UsageReportPrompts } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { usageReport: vi.fn(() => null) } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    isPending: false,
    error: null,
    refresh: mocks.refresh,
  }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
import { PromptUsageContent, UsagePrompts } from "./UsagePrompts";

const report: UsageReportPrompts = {
  contractVersion: 1,
  mode: "prompts",
  readAt: "2026-09-30T00:00:00Z",
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-29"),
  untilDay: UsageDay.make("2026-09-29"),
  scope: "t3UserMessages",
  coverage: {
    status: "complete",
    examinedMessages: 2,
    countedMessages: 2,
    truncatedMessages: 0,
    reasons: [],
  },
  totals: {
    prompts: 2,
    words: 6,
    characters: 30,
    threads: 1,
    activeDays: 1,
    averageWordsPerPrompt: 3,
  },
  daily: [{ day: UsageDay.make("2026-09-29"), prompts: 2, words: 6 }],
  words: [{ word: "build", count: 2 }],
  countedDistinctWords: 5,
  wordsTruncated: true,
  countingPolicy: "Stored messages only.",
};

describe("prompt usage rendering", () => {
  it("refreshes with the Usage-page refresh and reads environments separately", async () => {
    mocks.refresh.mockClear();
    const environment = {
      environmentId: EnvironmentId.make("desktop"),
      label: "Desktop",
      connection: { phase: "connected" },
      isPending: false,
      error: null,
      summary: null,
    } as EnvironmentUsageStatus;
    const props = { environments: [environment], selectedEnvironmentIds: null, window: report };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<UsagePrompts {...props} refreshRevision={0} />);
      });
      expect(mocks.refresh).not.toHaveBeenCalled();
      await act(async () => {
        renderer!.update(<UsagePrompts {...props} refreshRevision={1} />);
      });
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(renderer!.toJSON())).toContain("environments are not added together");
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
  it("renders count, frequent-word and daily data without token claims", () => {
    const html = renderToStaticMarkup(<PromptUsageContent report={report} />);
    expect(html).toContain("Words per prompt");
    expect(html).toContain("3.0");
    expect(html).toContain("build");
    expect(html).toContain("2026-09-29");
    expect(html).toContain("Showing 1 of 5 counted words");
  });
  it("keeps missing history distinct from an empty complete read", () => {
    const missing = renderToStaticMarkup(
      <PromptUsageContent
        report={{ ...report, coverage: { ...report.coverage, status: "missing" } }}
      />,
    );
    expect(missing).toContain("Prompt history is unavailable");
    expect(missing).not.toContain("Words per prompt");
    const empty = renderToStaticMarkup(
      <PromptUsageContent report={{ ...report, totals: { ...report.totals, prompts: 0 } }} />,
    );
    expect(empty).toContain("No stored user prompts");
  });
  it("labels partial counts and unavailable word averages", () => {
    const html = renderToStaticMarkup(
      <PromptUsageContent
        report={{
          ...report,
          coverage: { ...report.coverage, status: "partial" },
          totals: { ...report.totals, averageWordsPerPrompt: null },
        }}
      />,
    );
    expect(html).toContain("Partial history");
    expect(html).toContain("Unavailable");
  });
});
