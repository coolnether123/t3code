/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  publicHistory: {
    announcements: [],
    checkedAt: null,
    status: "loading",
  } as unknown,
  publicRefresh: vi.fn(),
  refresh: vi.fn(),
  news: vi.fn(),
  useUsage: vi.fn(),
}));
vi.mock("../../state/usage", () => ({
  useUsage: (...args: unknown[]) => state.useUsage(...args),
}));
vi.mock("@t3tools/client-runtime/resetAnnouncements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/resetAnnouncements")>()),
  watchResetAnnouncements: () => ({ refresh: state.news, stop: vi.fn() }),
}));
vi.mock("@t3tools/client-runtime/publicResetHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/publicResetHistory")>()),
  watchPublicResetHistory: (receive: (history: unknown) => void) => {
    receive(state.publicHistory);
    return { refresh: state.publicRefresh, stop: vi.fn() };
  },
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
  state.publicHistory = { announcements: [], checkedAt: null, status: "loading" };
  state.publicRefresh.mockReset().mockResolvedValue(undefined);
  state.refresh.mockReset().mockResolvedValue([]);
  state.news.mockReset().mockResolvedValue(undefined);
  state.useUsage.mockReset().mockImplementation(() => ({
    environments: state.environments,
    isPending: false,
    refresh: state.refresh,
  }));
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-30T22:00:00Z"));
});

describe("Codex monitor page", () => {
  it("uses separate history, cycle, public, pace, and chart activity reads", () => {
    renderToStaticMarkup(<UsageResetPage />);
    expect(state.useUsage).toHaveBeenCalledTimes(5);
  });

  it("refreshes current-cycle costs after each visible history reading", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const historyRefresh = vi.fn().mockResolvedValue([
      {
        environmentId: "local",
        summary: {
          quotaHistory: {
            status: "ready",
            samples: [
              {
                observedAt: "2026-08-30T20:00:00Z",
                remainingPercent: 90,
                resetsAt: "2026-09-06T00:00:00Z",
              },
              {
                observedAt: "2026-08-30T21:55:00Z",
                remainingPercent: 80,
                resetsAt: "2026-09-06T00:00:00Z",
              },
            ],
          },
        },
      },
    ]);
    const costRefresh = vi.fn().mockResolvedValue([]);
    let hookCalls = 0;
    state.useUsage.mockImplementation(() => ({
      environments: [],
      isPending: false,
      refresh: ++hookCalls % 5 === 1 ? historyRefresh : costRefresh,
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageResetPage />));
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(historyRefresh).toHaveBeenCalledTimes(1);
      expect(costRefresh).toHaveBeenCalledTimes(1);
      expect(costRefresh.mock.lastCall?.[0].quotaIntervals).toEqual([
        {
          id: "2026-08-30T20:00:00Z",
          sinceTime: "2026-08-30T20:00:00Z",
          untilTime: "2026-08-30T21:55:00Z",
        },
      ]);
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(historyRefresh).toHaveBeenCalledTimes(2);
      expect(costRefresh).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps fetching new readings while a cost scan is slow, then prices the latest interval", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let finishFirstCostScan!: (result: readonly unknown[]) => void;
    const firstCostScan = new Promise<readonly unknown[]>((resolve) => {
      finishFirstCostScan = resolve;
    });
    const samples = [
      {
        observedAt: "2026-08-30T20:00:00Z",
        remainingPercent: 90,
        resetsAt: "2026-09-06T00:00:00Z",
      },
      {
        observedAt: "2026-08-30T21:55:00Z",
        remainingPercent: 80,
        resetsAt: "2026-09-06T00:00:00Z",
      },
    ];
    const historyRefresh = vi.fn().mockImplementation(async () => [
      {
        environmentId: "local",
        summary: {
          quotaHistory: {
            status: "ready",
            samples:
              historyRefresh.mock.calls.length === 1
                ? samples
                : [...samples, { ...samples[1]!, observedAt: "2026-08-30T22:00:00Z" }],
          },
        },
      },
    ]);
    const costRefresh = vi.fn().mockReturnValueOnce(firstCostScan).mockResolvedValue([]);
    let hookCalls = 0;
    state.useUsage.mockImplementation(() => ({
      environments: [],
      isPending: false,
      refresh: ++hookCalls % 5 === 1 ? historyRefresh : costRefresh,
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageResetPage />));
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(historyRefresh).toHaveBeenCalledTimes(1);
      expect(costRefresh).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(historyRefresh).toHaveBeenCalledTimes(2);
      expect(costRefresh).toHaveBeenCalledTimes(1);
      await act(async () => finishFirstCostScan([]));
      expect(costRefresh).toHaveBeenCalledTimes(2);
      expect(costRefresh.mock.lastCall?.[0].quotaIntervals[0].untilTime).toBe(
        "2026-08-30T22:00:00Z",
      );
    } finally {
      finishFirstCostScan([]);
      await act(async () => root.unmount());
      container.remove();
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

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
      expect(state.publicRefresh).toHaveBeenCalledTimes(1);
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

  it("shows a reconnecting environment without pretending its usage query failed", () => {
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        connection: { phase: "reconnecting", error: "Socket closed", traceId: null },
        isPending: true,
        error: null,
        summary: null,
      },
    ];
    state.useUsage.mockImplementation(() => ({
      environments: state.environments,
      isPending: true,
      refresh: state.refresh,
    }));
    const markup = renderToStaticMarkup(<UsageResetPage />);
    expect(markup).toContain("Desktop: Reconnecting. Codex usage will appear");
    expect(markup).not.toContain("Reading Codex usage");
    expect(markup).not.toContain("No saved quota observations");
  });

  it("replaces the initial spinner when the first reading does not progress", async () => {
    vi.useFakeTimers();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        connection: { phase: "connecting", error: null, traceId: null },
        isPending: true,
        error: null,
        summary: null,
      },
    ];
    state.useUsage.mockImplementation(() => ({
      environments: state.environments,
      isPending: true,
      refresh: state.refresh,
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageResetPage />));
      expect(container.textContent).toContain("Reading Codex usage");
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(container.textContent).toContain("Codex usage is taking longer than expected");
      expect(container.textContent).not.toContain("Reading Codex usage");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });

  it("backdates public reset estimates without local quota observations", async () => {
    const fingerprint = {
      hostId: "desktop",
      provider: "codex",
      resolvedHomePath: "/sessions",
      volumeId: "1",
    };
    state.publicHistory = {
      checkedAt: Date.parse("2026-09-13T22:00:00Z"),
      status: "ready",
      announcements: [
        {
          id: "2094251180121854309",
          resetType: "regular",
          announcedAt: "2026-08-31T02:29:25Z",
          text: "Reset",
          sourceType: "x_post",
          sourceUrl: "https://x.com/thsottiaux/status/2094251180121854309",
        },
        {
          id: "2095651088502591861",
          resetType: "banked",
          announcedAt: "2026-09-03T23:12:30Z",
          text: "Banked reset",
          sourceType: "x_post",
          sourceUrl: "https://x.com/thsottiaux/status/2095651088502591861",
        },
        {
          id: "2098685367058612394",
          resetType: "regular",
          announcedAt: "2026-09-12T08:09:17Z",
          text: "Reset",
          sourceType: "x_post",
          sourceUrl: "https://x.com/thsottiaux/status/2098685367058612394",
        },
      ],
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
              intervalId: "codex-resets:2094251180121854309",
              fingerprint,
              costUsd: 12.5,
              records: 4,
              unpricedRecords: 0,
              complete: true,
              models: [
                {
                  model: "gpt-5.6-sol",
                  totals: {
                    uncachedInputTokens: 100,
                    cachedInputTokens: 50,
                    cacheCreationTokens: 25,
                    outputTokens: 20,
                    reasoningTokens: 10,
                  },
                  costUsd: 12.5,
                  records: 4,
                  unpricedRecords: 0,
                },
              ],
            },
          ],
        },
      },
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageResetPage />));
      expect(container.textContent).toContain("Estimated use between public resets");
      expect(container.textContent).toContain("1 banked reset grant is listed");
      expect(container.textContent).toContain("$12.50");
      expect(container.textContent).toContain("gpt-5.6-sol");
      expect(container.textContent).toContain("4 recorded usage rows");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
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
    expect(markup).not.toContain("No reset observed since");
    expect(markup).toContain("Jul");
    expect(markup).toContain("12% left");
    expect(markup).toContain("Window changed across an observation gap");
    expect(markup).not.toContain("Unexpected usage return");
    expect(markup).toContain("Tracking and computers");
    expect(markup).toContain("Check community with Luna");
    expect(markup.indexOf("Usage over time")).toBeLessThan(
      markup.indexOf("Check community with Luna"),
    );
    expect(markup.indexOf("Reset history")).toBeLessThan(
      markup.indexOf("Check community with Luna"),
    );
    expect(markup).toContain("Model comparisons at API prices");
  });
  it("shows a saved dollar cost for an older cycle after a monitoring gap", () => {
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
              costUsd: 5,
              records: 1,
              unpricedRecords: 0,
              complete: true,
            },
          ],
          quotaCostSnapshots: [
            {
              intervalId: "2026-08-27T20:00:00Z",
              fingerprint,
              sinceTime: "2026-08-27T20:00:00Z",
              untilTime: "2026-08-27T21:00:00Z",
              costUsd: 30,
              records: 4,
              recordedAt: "2026-08-27T22:00:00Z",
              firstRemainingPercent: 80,
              lastRemainingPercent: 60,
              resetsAt: "2026-08-28T00:00:00Z",
              models: [
                {
                  model: "gpt-6-astra",
                  costUsd: 30,
                  records: 4,
                  unpricedRecords: 0,
                  totals: {
                    uncachedInputTokens: 1_000_000,
                    cachedInputTokens: 200_000,
                    cacheCreationTokens: 50_000,
                    outputTokens: 40_000,
                    reasoningTokens: 20_000,
                  },
                },
              ],
            },
          ],
          quotaHistory: {
            status: "ready",
            source: "fixture",
            message: null,
            samples: [
              {
                observedAt: "2026-08-27T20:00:00Z",
                remainingPercent: 80,
                resetsAt: "2026-08-28T00:00:00Z",
              },
              {
                observedAt: "2026-08-27T21:00:00Z",
                remainingPercent: 60,
                resetsAt: "2026-08-28T00:00:00Z",
              },
              {
                observedAt: "2026-08-30T20:00:00Z",
                remainingPercent: 100,
                resetsAt: "2026-09-06T00:00:00Z",
              },
              {
                observedAt: "2026-08-30T22:00:00Z",
                remainingPercent: 99,
                resetsAt: "2026-09-06T00:00:00Z",
              },
            ],
          },
        },
      },
    ];
    const markup = renderToStaticMarkup(<UsageResetPage />);
    expect(markup).toContain("$30 observed cost");
    expect(markup).toContain("Dollar estimate not established");
    expect(markup).toContain("Per-model usage");
    expect(markup).toContain("1.25M input");
    expect(markup).toContain("40K output");
    expect(markup).toContain("gpt-6-astra");
    expect(markup).toContain("$30.00");
  });

  it("switches API values and token budgets with reset-cycle navigation", async () => {
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
              costUsd: 5,
              records: 1,
              unpricedRecords: 0,
              complete: true,
            },
          ],
          quotaCostSnapshots: [
            {
              intervalId: "2026-08-27T20:00:00Z",
              fingerprint,
              sinceTime: "2026-08-27T20:00:00Z",
              untilTime: "2026-08-27T21:00:00Z",
              costUsd: 30,
              records: 4,
              recordedAt: "2026-08-27T22:00:00Z",
              firstRemainingPercent: 80,
              lastRemainingPercent: 60,
              resetsAt: "2026-08-28T00:00:00Z",
              models: [
                {
                  model: "gpt-6-astra",
                  costUsd: 30,
                  records: 4,
                  unpricedRecords: 0,
                  totals: {
                    uncachedInputTokens: 1_000_000,
                    cachedInputTokens: 200_000,
                    cacheCreationTokens: 50_000,
                    outputTokens: 40_000,
                    reasoningTokens: 20_000,
                  },
                },
              ],
            },
          ],
          quotaHistory: {
            status: "ready",
            source: "fixture",
            message: null,
            samples: [
              {
                observedAt: "2026-08-27T20:00:00Z",
                remainingPercent: 80,
                resetsAt: "2026-08-28T00:00:00Z",
              },
              {
                observedAt: "2026-08-27T21:00:00Z",
                remainingPercent: 60,
                resetsAt: "2026-08-28T00:00:00Z",
              },
              {
                observedAt: "2026-08-30T20:00:00Z",
                remainingPercent: 100,
                resetsAt: "2026-09-06T00:00:00Z",
              },
              {
                observedAt: "2026-08-30T22:00:00Z",
                remainingPercent: 99,
                resetsAt: "2026-09-06T00:00:00Z",
              },
            ],
          },
        },
      },
    ];

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageResetPage />));
      expect(container.querySelector("#api-value")?.textContent).toContain("$5.00");
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Previous reset cycle"]')!.click(),
      );
      expect(container.querySelector("#api-value")?.textContent).toContain("$30.00");
      expect(container.querySelector("#api-value")?.textContent).toContain("≈ $90");
      expect(container.querySelector("#token-budget")?.textContent).not.toContain("Pending");
      expect(
        state.useUsage.mock.calls.some(([input]) =>
          input.quotaIntervals?.some(
            (interval: { id: string }) => interval.id === "2026-08-27T20:00:00Z",
          ),
        ),
      ).toBe(true);
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Next reset cycle"]')!.click(),
      );
      expect(container.querySelector("#api-value")?.textContent).toContain("$5.00");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it.each(["failed", "empty"] as const)(
    "keeps saved values visible for a %s newest cost query",
    (scenario) => {
      const fingerprint = {
        hostId: "desktop",
        provider: "codex",
        resolvedHomePath: "/sessions",
        volumeId: "1",
      };
      const priorModels = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(
        (model) => ({
          model,
          costUsd: 7.5,
          unpricedRecords: 0,
          records: 4,
          totals: {
            uncachedInputTokens: 10,
            cachedInputTokens: 2,
            cacheCreationTokens: 1,
            outputTokens: 7,
            reasoningTokens: 3,
          },
        }),
      );
      const historyEnvironment = {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: {
          sources: [{ fingerprint, status: "ok" }],
          quotaCostSnapshots: [
            {
              intervalId: "2026-08-30T19:00:00Z",
              fingerprint,
              sinceTime: "2026-08-30T19:00:00Z",
              untilTime: "2026-08-30T19:10:00Z",
              costUsd: 30,
              records: 4,
              recordedAt: "2026-08-30T19:20:00Z",
              firstRemainingPercent: 80,
              lastRemainingPercent: 60,
              resetsAt: "2026-08-28T00:00:00Z",
              models: priorModels,
            },
            ...(scenario === "failed"
              ? [
                  {
                    intervalId: "2026-08-30T20:00:00Z",
                    fingerprint,
                    sinceTime: "2026-08-30T20:00:00Z",
                    untilTime: "2026-08-30T20:05:00Z",
                    costUsd: 30,
                    records: 4,
                    recordedAt: "2026-08-30T20:10:00Z",
                    firstRemainingPercent: 100,
                    lastRemainingPercent: 95,
                    resetsAt: "2026-09-06T00:00:00Z",
                    models: priorModels,
                  },
                ]
              : []),
          ],
          quotaHistory: {
            status: "ready",
            source: "fixture",
            message: null,
            samples: [
              {
                observedAt: "2026-08-30T19:00:00Z",
                remainingPercent: 80,
                resetsAt: "2026-08-31T00:00:00Z",
              },
              {
                observedAt: "2026-08-30T19:10:00Z",
                remainingPercent: 60,
                resetsAt: "2026-08-31T00:00:00Z",
              },
              {
                observedAt: "2026-08-30T20:00:00Z",
                remainingPercent: 100,
                resetsAt: "2026-09-06T00:00:00Z",
              },
              ...(scenario === "failed"
                ? [
                    {
                      observedAt: "2026-08-30T20:05:00Z",
                      remainingPercent: 95,
                      resetsAt: "2026-09-06T00:00:00Z",
                    },
                    {
                      observedAt: "2026-08-30T20:10:00Z",
                      remainingPercent: 90,
                      resetsAt: "2026-09-06T00:00:00Z",
                    },
                  ]
                : []),
            ],
          },
        },
      };
      state.useUsage.mockImplementation((input: { quotaHistoryOnly?: boolean }) =>
        input.quotaHistoryOnly
          ? { environments: [historyEnvironment], isPending: false, refresh: state.refresh }
          : {
              environments: [
                scenario === "failed"
                  ? {
                      environmentId: "desktop",
                      label: "Desktop",
                      isPending: false,
                      error: "cost query failed",
                      summary: null,
                    }
                  : {
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
                            complete: true,
                            unpricedRecords: 0,
                            costUsd: 0,
                            records: 0,
                            models: [],
                          },
                        ],
                      },
                    },
              ],
              isPending: true,
              refresh: state.refresh,
            },
      );
      const markup = renderToStaticMarkup(<UsageResetPage />);
      expect(markup).toContain("$30 observed cost");
      expect(markup).toContain("Astra");
      expect(markup).toContain("Sol");
      expect(markup).toContain("Terra");
      expect(markup).toContain("Luna");
      const tokenPlanner = markup.slice(
        markup.indexOf('aria-label="API-price token comparisons"'),
        markup.indexOf('aria-label="API-price token comparisons"') + 5000,
      );
      expect(tokenPlanner).toMatch(/≈ [0-9.,]+[KMB]/);
      if (scenario === "failed") expect(tokenPlanner).toContain("$540.00");
      expect(tokenPlanner).not.toContain("Pending");
      expect(tokenPlanner).not.toContain("Exact model totals are not available yet");
      if (scenario === "failed") {
        expect(markup).toContain("Observed cost is complete through");
        expect(tokenPlanner).toContain("Provisional current-cycle value through");
      }
    },
  );

  it("does not list a clock-only change with an unchanged balance as a reset", () => {
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
          quotaCosts: [],
          quotaHistory: {
            status: "ready",
            source: "fixture",
            message: null,
            samples: [
              {
                observedAt: "2026-08-30T19:00:00Z",
                remainingPercent: 50,
                resetsAt: "2026-08-31T00:00:00Z",
              },
              {
                observedAt: "2026-08-30T20:00:00Z",
                remainingPercent: 50,
                resetsAt: "2026-09-06T00:00:00Z",
              },
              {
                observedAt: "2026-08-30T20:10:00Z",
                remainingPercent: 50,
                resetsAt: "2026-09-06T00:00:00Z",
              },
            ],
          },
        },
      },
    ];
    const markup = renderToStaticMarkup(<UsageResetPage />);
    expect(markup).toContain("No reset observed since");
    expect(markup).not.toContain("Usage window changed");
    expect(markup).not.toContain("$0.00 unused");
  });

  it.each(["short", "long"] as const)(
    "uses the selected calibration chain only for a safe %s bridge",
    (bridge) => {
      const fingerprint = {
        hostId: "desktop",
        provider: "codex",
        resolvedHomePath: "/sessions",
        volumeId: "1",
      };
      const models = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(
        (model) => ({
          model,
          costUsd: 7.5,
          unpricedRecords: 0,
          records: 4,
          totals: {
            uncachedInputTokens: 10,
            cachedInputTokens: 2,
            cacheCreationTokens: 1,
            outputTokens: 7,
            reasoningTokens: 3,
          },
        }),
      );
      const currentStart = bridge === "short" ? "2026-08-30T19:20:00Z" : "2026-08-30T20:20:00Z";
      const currentEnd = bridge === "short" ? "2026-08-30T19:25:00Z" : "2026-08-30T20:25:00Z";
      const currentSamples = [
        {
          observedAt: "2026-08-30T18:00:00Z",
          remainingPercent: 80,
          resetsAt: "2026-08-31T00:00:00Z",
        },
        {
          observedAt: "2026-08-30T19:00:00Z",
          remainingPercent: 60,
          resetsAt: "2026-08-31T00:00:00Z",
        },
        {
          observedAt: "2026-08-30T19:10:00Z",
          remainingPercent: 100,
          resetsAt: "2026-09-06T00:00:00Z",
        },
        {
          observedAt: "2026-08-30T19:15:00Z",
          remainingPercent: 100,
          resetsAt: "2026-09-06T01:00:00Z",
        },
        { observedAt: currentStart, remainingPercent: 100, resetsAt: "2026-09-06T02:00:00Z" },
        { observedAt: currentEnd, remainingPercent: 98, resetsAt: "2026-09-06T02:00:00Z" },
      ];
      const historyEnvironment = {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: {
          sources: [{ fingerprint, status: "ok" }],
          quotaCostSnapshots: [
            {
              intervalId: "2026-08-30T18:00:00Z",
              fingerprint,
              sinceTime: "2026-08-30T18:00:00Z",
              untilTime: "2026-08-30T19:00:00Z",
              costUsd: 30,
              records: 4,
              recordedAt: "2026-08-30T19:30:00Z",
              firstRemainingPercent: 80,
              lastRemainingPercent: 60,
              resetsAt: "2026-08-31T00:00:00Z",
              models,
            },
          ],
          quotaHistory: {
            status: "ready",
            source: "fixture",
            message: null,
            samples: currentSamples,
          },
        },
      };
      state.useUsage.mockImplementation((input: { quotaHistoryOnly?: boolean }) =>
        input.quotaHistoryOnly
          ? { environments: [historyEnvironment], isPending: false, refresh: state.refresh }
          : {
              environments: [
                {
                  environmentId: "desktop",
                  label: "Desktop",
                  isPending: true,
                  error: null,
                  summary: null,
                },
              ],
              isPending: true,
              refresh: state.refresh,
            },
      );
      const markup = renderToStaticMarkup(<UsageResetPage />);
      const tokenPlanner = markup.slice(
        markup.indexOf('aria-label="API-price token comparisons"'),
        markup.indexOf('aria-label="API-price token comparisons"') + 5000,
      );
      if (bridge === "short") {
        for (const label of ["GPT-6 Astra", "GPT-6 Sol", "GPT-5.6 Terra", "GPT-6 Luna"]) {
          const rowStart = tokenPlanner.indexOf(`<span>${label}</span>`);
          const row = tokenPlanner.slice(rowStart, tokenPlanner.indexOf("</tr>", rowStart));
          expect(row).toMatch(/≈ [0-9.,]+[KMB]/);
        }
        expect(tokenPlanner).not.toContain("Pending");
        expect(tokenPlanner).toContain("Provisional value from the previous completed cycle.");
        const sourceDates = `${new Date("2026-08-30T18:00:00Z").toLocaleString()} to ${new Date(
          "2026-08-30T19:00:00Z",
        ).toLocaleString()}`;
        expect(tokenPlanner).toContain(`Calibration: ${sourceDates}.`);
      } else {
        expect(tokenPlanner).toContain("Pending");
        expect(tokenPlanner).not.toContain("Provisional value from the previous completed cycle.");
      }
    },
  );

  it("defaults estimates to the healthy history tracker and preserves explicit pending opt-in", async () => {
    const fingerprint = {
      hostId: "desktop",
      provider: "codex",
      resolvedHomePath: "/sessions",
      volumeId: "1",
    };
    const healthy = {
      environmentId: "healthy",
      label: "Healthy computer",
      isPending: false,
      error: null,
      summary: {
        sources: [{ fingerprint, status: "ok" }],
        quotaCosts: [
          {
            intervalId: "2026-08-30T20:00:00Z",
            fingerprint,
            complete: true,
            unpricedRecords: 0,
            costUsd: 40,
            records: 4,
            models: [
              {
                model: "gpt-6-astra",
                costUsd: 40,
                unpricedRecords: 0,
                records: 4,
                totals: {
                  uncachedInputTokens: 10,
                  cachedInputTokens: 2,
                  cacheCreationTokens: 1,
                  outputTokens: 7,
                  reasoningTokens: 3,
                },
              },
            ],
          },
        ],
        quotaHistory: {
          status: "ready",
          source: "fixture",
          message: null,
          samples: [
            {
              observedAt: "2026-08-30T20:00:00Z",
              remainingPercent: 80,
              resetsAt: "2026-09-06T00:00:00Z",
            },
            {
              observedAt: "2026-08-30T21:00:00Z",
              remainingPercent: 70,
              resetsAt: "2026-09-06T00:00:00Z",
            },
          ],
        },
      },
    };
    const pending = {
      environmentId: "pending",
      label: "Pending computer",
      connection: { phase: "connecting", error: null, traceId: null },
      isPending: true,
      error: null,
      summary: null,
    };
    state.environments = [healthy, pending];
    const markup = renderToStaticMarkup(<UsageResetPage />);
    expect(markup).toContain("$40.00");
    expect(markup).toContain("Transcript costs from Healthy computer");
    expect(markup).not.toContain("Pending computer is still reading Codex transcripts");
    const tokenPlanner = markup.slice(
      markup.indexOf('aria-label="API-price token comparisons"'),
      markup.indexOf('aria-label="API-price token comparisons"') + 5000,
    );
    expect(tokenPlanner).toMatch(/≈ [0-9.,]+[KMB]/);
    expect(tokenPlanner).not.toContain("Pending");

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageResetPage />));
      const computers = container.querySelectorAll<HTMLInputElement>(
        'fieldset input[type="checkbox"]',
      );
      expect(computers).toHaveLength(2);
      await act(async () => computers[1]!.click());
      expect(container.textContent).toContain(
        "Pending computer is still reading Codex transcripts",
      );
      expect(container.textContent).toContain(
        "Transcript costs from Healthy computer, Pending computer",
      );
      expect(container.textContent).toContain("Pending");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
