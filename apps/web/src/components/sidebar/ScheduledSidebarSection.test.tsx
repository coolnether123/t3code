/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  listRoutines: vi.fn(),
  listRuns: vi.fn(),
  navigate: vi.fn(),
  closeMobile: vi.fn(),
}));
vi.mock("../../scheduledApi", () => ({ scheduledApi: state }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../ui/sidebar", () => ({
  SidebarGroup: "section",
  useSidebar: () => ({ isMobile: true, setOpenMobile: state.closeMobile }),
}));

import { ScheduledSidebarSection } from "./ScheduledSidebarSection";

afterEach(() => vi.clearAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Scheduled sidebar", () => {
  it("loads only on expansion and opens archived runs outside normal chats", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const run = {
      id: "run-1",
      createdAt: "2026-09-28T12:00:00.000Z",
      preview: "matched",
      archived: true,
    };
    state.listRoutines.mockResolvedValue({
      routines: [{ name: "Inbox", latestRun: run, runCount: 2 }],
      nextCursor: null,
    });
    state.listRuns.mockResolvedValue({ runs: [run], nextCursor: null });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ScheduledSidebarSection />));
      expect(state.listRoutines).not.toHaveBeenCalled();
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      expect(state.listRoutines).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("Inbox");
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("Inbox"))!
          .click(),
      );
      expect(state.listRuns).toHaveBeenCalledWith("Inbox", undefined);
      expect(container.textContent).toContain("Archived");
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("matched"))!
          .click(),
      );
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/scheduled/$runId",
        params: { runId: "run-1" },
      });
      expect(state.closeMobile).toHaveBeenCalledWith(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not append an older page after a newer focus refresh", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const run = { id: "run-1", createdAt: "2026-09-28T12:00:00.000Z" };
    const inbox = { name: "Inbox", latestRun: run, runCount: 1 };
    const oldPage = deferred<{ routines: (typeof inbox)[]; nextCursor: null }>();
    const refresh = deferred<{ routines: (typeof inbox)[]; nextCursor: null }>();
    state.listRoutines
      .mockResolvedValueOnce({ routines: [inbox], nextCursor: "older" })
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(refresh.promise);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ScheduledSidebarSection />));
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "More routines")!
          .click(),
      );
      await act(async () => window.dispatchEvent(new Event("focus")));
      expect(state.listRoutines).toHaveBeenCalledTimes(3);
      await act(async () =>
        oldPage.resolve({
          routines: [{ ...inbox, name: "Obsolete routine" }],
          nextCursor: null,
        }),
      );
      expect(container.textContent).not.toContain("Obsolete routine");
      expect(container.textContent).toContain("Loading");
      await act(async () => refresh.resolve({ routines: [inbox], nextCursor: null }));
      expect(container.textContent).toContain("Inbox");
      expect(container.textContent).not.toContain("Loading");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("ignores an older run-history error after reopening loads successfully", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const run = {
      id: "run-1",
      createdAt: "2026-09-28T12:00:00.000Z",
      preview: "Current run",
      archived: false,
    };
    const oldPage = deferred<{ runs: (typeof run)[]; nextCursor: null }>();
    state.listRoutines.mockResolvedValue({
      routines: [{ name: "Inbox", latestRun: run, runCount: 1 }],
      nextCursor: null,
    });
    state.listRuns
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ runs: [run], nextCursor: null });
    const container = document.createElement("div");
    const root = createRoot(container);
    const toggleInbox = () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Inbox"))!
        .click();
    try {
      await act(async () => root.render(<ScheduledSidebarSection />));
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      await act(async () => toggleInbox());
      await act(async () => toggleInbox());
      await act(async () => toggleInbox());
      expect(container.textContent).toContain("Current run");
      await act(async () => oldPage.reject(new Error("Old request failed")));
      expect(container.textContent).not.toContain("Could not load run history");
      expect(container.textContent).toContain("Current run");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
