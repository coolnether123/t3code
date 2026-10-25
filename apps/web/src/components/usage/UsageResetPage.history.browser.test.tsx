import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { UsageResetPage } from "./UsageResetPage";
import type { UsageSummaryInput } from "@t3tools/contracts";
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
vi.mock("../../env", async (original) => ({
  ...(await original<typeof import("../../env")>()),
  isElectron: false,
}));
vi.mock("../ui/scroll-area", async (original) => ({
  ...(await original<typeof import("../ui/scroll-area")>()),
  ScrollArea: "div",
}));
vi.mock("../ui/sidebar", async (original) => ({
  ...(await original<typeof import("../ui/sidebar")>()),
  SidebarInset: "div",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));

it("starts July backfill and shows paid value without opening History", async () => {
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
  await using screen = await render(<UsageResetPage />);
  await expect.element(screen.getByText(/paid.*\$123.00 estimated API value/)).toBeVisible();
  await expect
    .element(screen.getByText(/paid.*estimated API value.*Incomplete transcript history/))
    .toBeVisible();
  expect(
    state.useUsage.mock.calls.some(([input]) =>
      input.quotaIntervals?.some(
        (interval: { sinceTime: string }) => interval.sinceTime === "2026-07-01T00:00:00.000Z",
      ),
    ),
  ).toBe(true);
});
