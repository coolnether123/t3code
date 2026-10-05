import { EnvironmentId, UsageDay, type UsageReportPrompts } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  query: vi.fn(),
  error: null as string | null,
}));
// This Node rendering fixture shares the web renderer, without importing mobile
// source into the web TypeScript project or loading React Native's native host.
vi.mock("../../../mobile/node_modules/react-native", () => ({ View: "div", Pressable: "button" }));
vi.mock("../../../mobile/node_modules/react", async () => await import("react"));
vi.mock("../../../mobile/src/components/AppText", () => ({ AppText: "span" }));
vi.mock("../../../mobile/src/features/settings/components/SettingsSection", () => ({
  SettingsSection: "section",
}));
vi.mock("../../../mobile/src/state/server", () => ({
  serverEnvironment: { usageReport: mocks.query },
}));
vi.mock("../../../mobile/src/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    isPending: false,
    error: mocks.error,
    refresh: mocks.refresh,
  }),
}));
import { PromptUsageContent, UsagePrompts } from "../../../mobile/src/features/usage/UsagePrompts";

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
  countingPolicy: "Synthetic stored messages only.",
};

describe("mobile prompt usage", () => {
  it("renders counts, frequent words and daily totals", () => {
    const html = renderToStaticMarkup(<PromptUsageContent report={report} />);
    for (const text of [
      "Words per prompt",
      "3.0",
      "build",
      "2026-09-29",
      "Showing 1 of 5 counted words",
    ])
      expect(html).toContain(text);
  });
  it("does not render missing history as zero", () => {
    const html = renderToStaticMarkup(
      <PromptUsageContent
        report={{ ...report, coverage: { ...report.coverage, status: "missing" } }}
      />,
    );
    expect(html).toContain("Prompt history is unavailable");
    expect(html).not.toContain("Words per prompt");
  });
  it("labels partial counts and keeps a null average unavailable", () => {
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
  it("distinguishes an empty complete read from missing history", () => {
    const html = renderToStaticMarkup(
      <PromptUsageContent report={{ ...report, totals: { ...report.totals, prompts: 0 } }} />,
    );
    expect(html).toContain("No stored user prompts in this period");
    expect(html).not.toContain("Daily prompt usage");
  });
  it("queries environments separately with exact times and refreshes on pull-to-refresh", async () => {
    mocks.error = null;
    mocks.refresh.mockClear();
    mocks.query.mockClear();
    const environments = ["one", "two"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      label: id,
      isPending: false,
      error: null,
      summary: null,
    }));
    const window = {
      ...report,
      sinceTime: "2026-09-29T12:00:00Z",
      untilTime: "2026-09-29T20:00:00Z",
    };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <UsagePrompts environments={environments} window={window} refreshRevision={0} />,
        );
      });
      for (const environment of environments)
        expect(mocks.query).toHaveBeenCalledWith({
          environmentId: environment.environmentId,
          input: {
            mode: "prompts",
            sinceDay: report.sinceDay,
            untilDay: report.untilDay,
            timeZone: "UTC",
            sinceTime: window.sinceTime,
            untilTime: window.untilTime,
            limit: 20,
          },
        });
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(JSON.stringify(renderer!.toJSON())).toContain("environments are not added together");
      await act(async () => {
        renderer!.update(
          <UsagePrompts environments={environments} window={window} refreshRevision={1} />,
        );
      });
      expect(mocks.refresh).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
  it("reports unavailable environments without exposing the transport error", () => {
    mocks.error = "synthetic transport detail";
    const html = renderToStaticMarkup(
      <UsagePrompts
        environments={[
          {
            environmentId: EnvironmentId.make("one"),
            label: "one",
            isPending: false,
            error: null,
            summary: null,
          },
        ]}
        window={report}
        refreshRevision={0}
      />,
    );
    expect(html).toContain("Connect this environment");
    expect(html).not.toContain("synthetic transport detail");
    mocks.error = null;
  });
});
