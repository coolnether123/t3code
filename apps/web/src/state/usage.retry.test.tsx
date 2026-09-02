/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UsageDay } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [
    {
      environmentId: "desktop",
      label: "Desktop",
      isPending: false,
      error: "This environment could not report usage.",
      summary: null,
    },
  ],
  execute: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.environments }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: (...args: unknown[]) => state.execute(...args),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./presentation", () => ({
  environmentPresentations: { presentationsAtom: {} },
}));
vi.mock("./server", () => ({
  serverEnvironment: { usageSummary: (request: unknown) => request },
}));

import { useUsage } from "./usage";

function UsageProbe() {
  useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return null;
}

beforeEach(() => {
  state.execute
    .mockReset()
    .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
});

describe("usage route recovery", () => {
  it("retries a retained environment failure once when the route mounts", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsageProbe />));
      expect(state.execute).toHaveBeenCalledTimes(1);
      await act(async () => root.render(<UsageProbe />));
      expect(state.execute).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
