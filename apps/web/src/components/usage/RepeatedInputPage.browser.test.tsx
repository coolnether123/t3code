import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { UsageRepeatedInputSummary } from "@t3tools/contracts";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({ useUsage: vi.fn(), refresh: vi.fn() }));
vi.mock("../../state/usage", () => ({ useUsage: state.useUsage }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: "a",
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));

import { RepeatedInputPage } from "./RepeatedInputPage";

const attribution: UsageRepeatedInputSummary = {
  items: [],
  totals: [],
  coverageGaps: [],
  estimatedApiCostUsd: 0.12,
  priceStatus: "estimated",
};
const desktop = {
  environmentId: "desktop",
  label: "Desktop",
  isPending: false,
  error: null,
  summary: { sources: [], repeatedInput: attribution },
};

function setup() {
  vi.clearAllMocks();
  state.useUsage.mockReturnValue({ environments: [desktop], refresh: state.refresh });
}

describe("RepeatedInputPage", () => {
  it("opens attribution as a separate page with a return link and opt-in request", () => {
    setup();
    const markup = renderToStaticMarkup(<RepeatedInputPage />);
    expect(markup).toContain("Skills &amp; repeated input");
    expect(markup).toContain('to="/usage"');
    expect(markup).toContain("Attribution overview");
    expect(markup).not.toContain("Codex usage &amp; resets");
    expect(state.useUsage.mock.calls[0]?.[0]).toMatchObject({ includeRepeatedInput: true });
  });

  it("distinguishes scanning, unavailable, unsupported and empty attribution", () => {
    setup();
    state.useUsage.mockReturnValue({
      environments: [{ ...desktop, isPending: true, summary: null }],
      refresh: state.refresh,
    });
    expect(renderToStaticMarkup(<RepeatedInputPage />)).toContain("Reading repeated input");
    state.useUsage.mockReturnValue({
      environments: [{ ...desktop, error: "Offline", summary: null }],
      refresh: state.refresh,
    });
    expect(renderToStaticMarkup(<RepeatedInputPage />)).toContain("Attribution unavailable");
    state.useUsage.mockReturnValue({
      environments: [{ ...desktop, summary: { sources: [] } }],
      refresh: state.refresh,
    });
    expect(renderToStaticMarkup(<RepeatedInputPage />)).toContain("servers support attribution");
    state.useUsage.mockReturnValue({ environments: [desktop], refresh: state.refresh });
    expect(renderToStaticMarkup(<RepeatedInputPage />)).toContain(
      "No repeated payload was confirmed",
    );
  });

  it("keeps returned attribution visible while naming a missing computer", () => {
    setup();
    state.useUsage.mockReturnValue({
      environments: [
        desktop,
        { ...desktop, environmentId: "laptop", label: "Laptop", error: "Offline", summary: null },
      ],
      refresh: state.refresh,
    });
    const markup = renderToStaticMarkup(<RepeatedInputPage />);
    expect(markup).toContain("Attribution overview");
    expect(markup).toContain("Showing available attribution");
    expect(markup).toContain("Laptop: Offline");
    expect(markup).toContain("$0.12");
  });

  it("changes the period query and scopes the overview to the selected computer", async () => {
    setup();
    state.useUsage.mockReturnValue({
      environments: [
        desktop,
        {
          ...desktop,
          environmentId: "laptop",
          label: "Laptop",
          summary: { sources: [], repeatedInput: { ...attribution, estimatedApiCostUsd: 0.2 } },
        },
      ],
      refresh: state.refresh,
    });
    await using screen = await render(<RepeatedInputPage />);
    const container = screen.container;
    expect(container.textContent).toContain("$0.32");
    const computer = container.querySelector<HTMLSelectElement>(
      '[aria-label="Repeated input computer"]',
    )!;
    await act(async () => {
      computer.value = "desktop";
      computer.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("$0.12");
    expect(container.textContent).not.toContain("$0.32");
    const prior = state.useUsage.mock.lastCall?.[0];
    const period = container.querySelector<HTMLSelectElement>(
      '[aria-label="Repeated input period"]',
    )!;
    await act(async () => {
      period.value = "7";
      period.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(state.useUsage.mock.lastCall?.[0].sinceDay).not.toEqual(prior.sinceDay);
    expect(state.useUsage.mock.lastCall?.[0].includeRepeatedInput).toBe(true);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh repeated input"]')!.click(),
    );
    expect(state.refresh).toHaveBeenCalledOnce();
  });
});
