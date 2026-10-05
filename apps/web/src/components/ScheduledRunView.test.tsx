/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ getRun: vi.fn(), navigate: vi.fn() }));
vi.mock("../scheduledApi", () => ({ scheduledApi: state }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("./ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock("./ui/sidebar", () => ({ SidebarInset: "section" }));
vi.mock("./ui/button", () => ({ Button: "button" }));

import { ScheduledRunView } from "./ScheduledRunView";

function page(id: string, nextCursor: string | null = null) {
  return {
    thread: {
      id,
      title: `Automation: ${id}`,
      updatedAt: "2026-10-04T12:00:00.000Z",
      preview: null,
      cwd: null,
      status: "unknown",
    },
    messages: [
      { id: `${id}-message`, role: "assistant", text: `${id} answer`, createdAt: null, tool: null },
    ],
    nextCursor,
  };
}

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("Scheduled run selection", () => {
  it("clears the previous transcript and ignores its late older-page response", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let finishOlder!: (value: ReturnType<typeof page>) => void;
    let finishLatest!: (value: ReturnType<typeof page>) => void;
    state.getRun.mockImplementation((id: string, cursor?: string) => {
      if (cursor)
        return new Promise((resolve) => {
          finishOlder = resolve;
        });
      if (id === "second")
        return new Promise((resolve) => {
          finishLatest = resolve;
        });
      return Promise.resolve(page(id, "older"));
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ScheduledRunView runId="first" />));
      expect(container.textContent).toContain("first answer");
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Older messages")!
          .click(),
      );
      expect(state.getRun).toHaveBeenCalledWith("first", "older");
      await act(async () => root.render(<ScheduledRunView runId="second" />));
      expect(container.textContent).not.toContain("first answer");
      expect(container.textContent).toContain("Loading");
      await act(async () => finishLatest(page("second")));
      await act(async () => finishOlder(page("first-older")));
      expect(container.textContent).toContain("second answer");
      expect(container.textContent).not.toContain("first-older answer");
      expect(container.textContent).not.toContain("Older messages");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("does not carry a failed run's error into a newly selected run", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.getRun.mockRejectedValueOnce(new Error("Synthetic missing run"));
    state.getRun.mockResolvedValueOnce(page("available"));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ScheduledRunView runId="missing" />));
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      await act(async () => root.render(<ScheduledRunView runId="available" />));
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain("available answer");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
