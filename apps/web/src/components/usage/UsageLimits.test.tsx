import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("./UsageLimitsPooled", () => ({
  UsageLimitsPooled: ({ now }: { readonly now: number }) => `clock:${now}`,
}));

import { UsageLimitsSection } from "./UsageLimits";

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("updates reset countdowns on minute boundaries and clears its timer on unmount", async () => {
  await act(() => {
    renderer = create(<UsageLimitsSection selectedEnvironmentIds={null} now={1_000_000} />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("clock:1000000");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(19_999);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("clock:1000000");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("clock:1020000");

  await act(() => renderer.unmount());
  expect(vi.getTimerCount()).toBe(0);
});
