import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { page } from "vite-plus/test/browser";
import { UsageResetPage } from "./UsageResetPage";
import type { UsageSummaryInput } from "@t3tools/contracts";
import "~/index.css";
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
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: "a",
}));
vi.mock("../ui/scroll-area", async (original) => ({
  ...(await original<typeof import("../ui/scroll-area")>()),
  ScrollArea: "div",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));

it.each([390, 1440])("shows paid value and starts backfill at width %s", async (width) => {
  await page.viewport(width, 900);
  state.publicHistory = { announcements: [], checkedAt: 0, status: "ready" };
  state.environments = [
    {
      environmentId: "desktop",
      label: "Desktop",
      isPending: false,
      error: null,
      summary: { readAt: "2026-10-25T08:00:00Z", sources: [], quotaCostSnapshots: [] },
    },
  ];
  window.localStorage.setItem(
    "t3code:usage-limits-view:v1",
    JSON.stringify({ provider: "codex", tab: "public" }),
  );
  state.useUsage.mockImplementation((input: UsageSummaryInput) => ({
    environments: input.quotaIntervals?.some((row) => row.id.startsWith("transcript-window:"))
      ? [
          {
            environmentId: "desktop",
            label: "Desktop",
            isPending: false,
            error: null,
            summary: {
              readAt: "2026-10-25T08:00:00Z",
              sources: [
                { status: "partial", message: "Cached transcripts no longer have source files" },
              ],
              quotaCosts: input.quotaIntervals.map((row) => ({
                intervalId: row.id,
                complete: false,
                costUsd: 123,
                records: 1,
                unpricedRecords: 0,
                fingerprint: {
                  hostId: "desktop",
                  provider: "codex",
                  resolvedHomePath: "/sessions",
                  volumeId: "1",
                },
              })),
            },
          },
        ]
      : state.environments,
    isPending: false,
    refresh: state.refresh,
  }));
  await using _screen = await render(<UsageResetPage />);
  await expect.element(page.getByRole("dialog", { name: "Limits" })).toBeVisible();
  await expect.element(page.getByText(/paid.*\$123.00 estimated API value/)).toBeVisible();
  await expect
    .element(page.getByText(/paid.*estimated API value.*Incomplete transcript history/))
    .toBeVisible();
  expect(
    state.useUsage.mock.calls.some(([input]) =>
      input.quotaIntervals?.some(
        (interval: { sinceTime: string }) => interval.sinceTime === "2026-07-01T00:00:00.000Z",
      ),
    ),
  ).toBe(true);
  await page.screenshot({ path: `__screenshots__/limits-modal-${width}.png` });
});

it.each([false, true])(
  "counts recent windows with an empty saved home, scan complete=%s",
  async (complete) => {
    state.publicHistory = { announcements: [], checkedAt: 0, status: "ready" };
    const fingerprint = {
      hostId: "desktop",
      provider: "codex",
      resolvedHomePath: "/sessions",
      volumeId: "1",
    };
    const start = "2026-10-25T06:10:31.050Z";
    const end = "2026-10-25T12:20:00Z";
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: {
          readAt: end,
          sources: [],
          quotaCostSnapshots: [
            {
              intervalId: start,
              sinceTime: start,
              untilTime: end,
              costUsd: 0,
              records: 0,
              fingerprint: { ...fingerprint, resolvedHomePath: "/empty" },
              recordedAt: end,
              firstRemainingPercent: 100,
              lastRemainingPercent: 56,
              resetsAt: "2026-11-01T06:10:00Z",
            },
          ],
        },
      },
    ];
    window.localStorage.setItem(
      "t3code:usage-limits-view:v1",
      JSON.stringify({ provider: "codex", tab: "cycles" }),
    );
    state.useUsage.mockImplementation((input: UsageSummaryInput) => ({
      environments: input.quotaIntervals
        ? [
            {
              ...(state.environments[0] as object),
              summary: {
                readAt: end,
                sources: [
                  {
                    status: complete ? "ok" : "partial",
                    message: complete ? null : "Cached transcripts no longer have source files",
                  },
                ],
                quotaCosts: input.quotaIntervals.map((interval) => ({
                  intervalId: interval.id,
                  complete,
                  costUsd: interval.id.startsWith("month:")
                    ? 321
                    : interval.sinceTime === start
                      ? 123
                      : 0,
                  records: 1,
                  unpricedRecords: 0,
                  fingerprint,
                })),
              },
            },
          ]
        : state.environments,
      isPending: false,
      refresh: state.refresh,
    }));
    await using _screen = await render(<UsageResetPage />);
    await expect.element(page.getByText(/paid.*\$123.00 estimated API value/)).toBeVisible();
    await expect
      .element(
        page.getByText(complete ? /^\$123.00$/ : /^\$123.00 · Incomplete transcript history$/),
      )
      .toBeVisible();
    await page.getByText(/paid.*estimated API value/).click();
    await expect
      .element(
        page
          .getByText(
            complete ? /\$321.00 value · 1.6×$/ : /\$321.00 value.*Incomplete transcript history/,
          )
          .first(),
      )
      .toBeVisible();
  },
);
