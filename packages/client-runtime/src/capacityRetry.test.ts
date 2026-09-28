import { describe, expect, it } from "vite-plus/test";
import { isCapacityRetryWaiting } from "./capacityRetry.ts";

describe("capacity retry status", () => {
  const waiting = { kind: "capacity.retry.waiting", turnId: "failed-1" };
  const finished = { kind: "capacity.retry.finished", turnId: "failed-1" };

  it("shows a waiting failed turn regardless of activity ordering", () => {
    expect(isCapacityRetryWaiting("error", [waiting])).toBe(true);
    expect(isCapacityRetryWaiting("error", [finished, waiting])).toBe(false);
    expect(isCapacityRetryWaiting("error", [waiting, finished])).toBe(false);
  });

  it("only closes the matching failed turn and hides waits outside error state", () => {
    expect(
      isCapacityRetryWaiting("error", [
        finished,
        waiting,
        { kind: "capacity.retry.waiting", turnId: "failed-2" },
      ]),
    ).toBe(true);
    expect(isCapacityRetryWaiting("running", [waiting])).toBe(false);
    expect(isCapacityRetryWaiting("stopped", [waiting])).toBe(false);
  });
});
