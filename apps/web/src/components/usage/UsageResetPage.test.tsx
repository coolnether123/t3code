/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  refresh: vi.fn(),
  news: vi.fn(),
}));
vi.mock("../../state/usage", () => ({
  useUsage: () => ({ environments: state.environments, isPending: false, refresh: state.refresh }),
}));
vi.mock("@t3tools/client-runtime/resetAnnouncements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/resetAnnouncements")>()),
  watchResetAnnouncements: () => ({ refresh: state.news, stop: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({ Link: "a" }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./ResetCheckPanel", () => ({ ResetCheckPanel: () => <button>Check X with Luna</button> }));
vi.mock("./CommunityCheckPanel", () => ({
  CommunityCheckPanel: () => <button>Check community with Luna</button>,
}));

import { UsageResetPage } from "./UsageResetPage";

beforeEach(() => {
  state.environments = [];
  state.refresh.mockReset().mockResolvedValue([]);
  state.news.mockReset().mockResolvedValue(undefined);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-30T22:00:00Z"));
});

describe("Codex monitor page", () => {
  it("shows progress, ignores repeated taps, then enables retry after failure", async () => {
    let reject!: (reason: Error) => void;
    state.refresh.mockReturnValue(
      new Promise<readonly unknown[]>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageResetPage />));
      const button = container.querySelector<HTMLButtonElement>(
        '[aria-label="Refresh Codex usage"]',
      )!;
      await act(async () => {
        button.click();
        button.click();
      });
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(container.textContent).toContain("Refreshing readings");
      expect(state.refresh).toHaveBeenCalledTimes(1);
      expect(state.news).toHaveBeenCalledTimes(1);
      await act(async () => reject(new Error("disconnected")));
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-busy")).toBe("false");
      expect(container.textContent).toContain("Refresh did not finish");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  it("does not show zero balance or dollars when no tracker data exists", () => {
    const markup = renderToStaticMarkup(<UsageResetPage />);
    expect(markup).toContain("No saved quota observations");
    expect(markup).toContain('to="/usage"');
    expect(markup).toContain('aria-label="Refresh Codex usage"');
    expect(markup).not.toContain("$0.00");
  });
  it("shows total usage separately from monitored usage and excludes archived runs", () => {
    const fingerprint = {
      hostId: "desktop",
      provider: "codex",
      resolvedHomePath: "/sessions",
      volumeId: "1",
    };
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: {
          sources: [{ fingerprint, status: "ok" }],
          quotaCosts: [
            {
              intervalId: "2026-08-30T20:00:00Z",
              fingerprint,
              costUsd: 40,
              records: 10,
              unpricedRecords: 0,
              complete: true,
            },
          ],
          quotaHistory: {
            status: "ready",
            source: "fixture",
            message: null,
            samples: [
              {
                observedAt: "2026-07-21T17:00:00Z",
                remainingPercent: 12,
                resetsAt: "2026-07-25T03:00:00Z",
              },
              {
                observedAt: "2026-08-30T20:00:00Z",
                remainingPercent: 83,
                resetsAt: "2026-09-05T21:21:08Z",
              },
              {
                observedAt: "2026-08-30T22:00:00Z",
                remainingPercent: 81,
                resetsAt: "2026-09-05T21:21:08Z",
              },
            ],
          },
        },
      },
    ];
    const markup = renderToStaticMarkup(<UsageResetPage />);
    expect(markup).toContain("81%");
    expect(markup).toContain("19%");
    expect(markup).toContain("used this cycle");
    expect(markup).toContain("2-point drop");
    expect(markup).toContain("already used 17%");
    expect(markup).toContain("$40.00");
    expect(markup).toContain("Learning");
    expect(markup).toContain("2 of 5 percentage points");
    expect(markup).toContain("No reset observed since");
    expect(markup).not.toContain("Jul");
    expect(markup).not.toContain("12%");
    expect(markup).not.toContain("Unexpected usage return");
    expect(markup).toContain("Tracking and computers");
    expect(markup).toContain("Check community with Luna");
  });
});
