import { EnvironmentId, UsageDay, type UsageReportPrompts } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), report: vi.fn(() => null) }));
vi.mock("../../state/server", () => ({ serverEnvironment: { usageReport: mocks.report } }));
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
  it("shows partial indexing progress without inventing older producer coverage", () => {
    const partial = {
      ...report,
      coverage: { ...report.coverage, status: "partial" as const, sourceMessages: 100 },
    };
    const html = renderToStaticMarkup(<PromptUsageContent report={partial} />);
    expect(html).toContain("Indexed 2 of 100 stored prompts");
    expect(html).toContain("Refresh to check progress");
    expect(renderToStaticMarkup(<PromptUsageContent report={report} />)).not.toContain("Indexed");
  });
  it("submits and clears a keyword without sending searches on each keystroke", async () => {
    mocks.report.mockClear();
    const environment = {
      environmentId: EnvironmentId.make("fixture"),
      label: "Fixture",
      connection: { phase: "connected" },
    } as EnvironmentUsageStatus;
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <UsagePrompts
            environments={[environment]}
            selectedEnvironmentIds={null}
            window={{ sinceDay: report.sinceDay, untilDay: report.untilDay, timeZone: "UTC" }}
            refreshRevision={0}
          />,
        );
      });
      await act(async () =>
        renderer!.root.findByType("input").props.onChange({ target: { value: "the" } }),
      );
      expect(mocks.report).toHaveBeenLastCalledWith(
        expect.objectContaining({
          input: expect.not.objectContaining({ keyword: expect.anything() }),
        }),
      );
      await act(async () =>
        renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
      );
      expect(mocks.report).toHaveBeenLastCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ keyword: "the" }),
        }),
      );
      await act(async () =>
        renderer!.root
          .findAllByType("button")
          .find((button) => button.props.children === "Clear")!
          .props.onClick(),
      );
      expect(mocks.report).toHaveBeenLastCalledWith(
        expect.objectContaining({
          input: expect.not.objectContaining({ keyword: expect.anything() }),
        }),
      );
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
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
    const props = {
      environments: [environment],
      selectedEnvironmentIds: null,
      window: { sinceDay: report.sinceDay, untilDay: report.untilDay, timeZone: report.timeZone },
    };
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
  it("shows keyword counts and counting rules with partial-source qualifiers", () => {
    const html = renderToStaticMarkup(
      <PromptUsageContent
        report={{
          ...report,
          keyword: { word: "the", count: 10, prompts: 2 },
          coverage: { ...report.coverage, status: "partial", reasons: ["index-warming"] },
        }}
      />,
    );
    expect(html).toContain("10 occurrences in 2 prompts");
    expect(html).toContain("Counting rules and source coverage");
    expect(html).toContain("index-warming");
    const empty = renderToStaticMarkup(
      <PromptUsageContent
        report={{
          ...report,
          totals: { ...report.totals, prompts: 0 },
          coverage: { ...report.coverage, status: "partial" },
        }}
      />,
    );
    expect(empty).not.toContain("No stored user prompts in this period");
    expect(empty).toContain("history is partial");
  });
});
