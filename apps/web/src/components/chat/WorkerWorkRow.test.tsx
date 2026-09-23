import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { FriendlyWorkerToolCallRow } from "./MessagesTimeline";

afterEach(() => vi.unstubAllGlobals());

describe("Worker start row", () => {
  it("shows the worker assignment and result on expansion", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <FriendlyWorkerToolCallRow
            call={{
              toolName: "worker_start",
              action: "Started Worker",
              state: "completed",
              workerIds: ["worker-1"],
              workers: [
                {
                  id: "worker-1",
                  name: "Scout",
                  assignment: "Check the provider adapter",
                  model: "gpt-6-luna",
                  status: "running",
                },
              ],
              startedAt: "2026-01-01T00:00:00Z",
              rawData: { internal: "available under technical details" },
            }}
          />,
        );
      });
      const toggle = renderer!.root.findByProps({
        "aria-label": "Show Worker activity for worker_start",
      });
      expect(toggle.props["aria-expanded"]).toBe(false);
      await act(async () => toggle.props.onClick());
      expect(renderer!.root.findByProps({ "aria-label": "Workers started" })).toBeDefined();
      expect(renderer!.root.findAllByType("li")[0]!.findByType("p").children).toContain(
        "Check the provider adapter",
      );
      expect(
        renderer!.root.findByProps({ "aria-label": "Hide Worker activity for worker_start" }).props[
          "aria-expanded"
        ],
      ).toBe(true);
    } finally {
      await act(async () => renderer?.unmount());
    }
  });
});
