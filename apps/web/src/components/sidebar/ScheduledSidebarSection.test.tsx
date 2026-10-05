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
});
