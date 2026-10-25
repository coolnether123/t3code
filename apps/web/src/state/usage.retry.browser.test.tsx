import { act, render, fakeTimers } from "../../test/render";
import { useState } from "react";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { USAGE_CONTRACT_VERSION, UsageDay, type UsageSummary } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [
    {
      environmentId: "desktop",
      label: "Desktop",
      isPending: false,
      error: "This environment could not report usage." as string | null,
      summary: null as UsageSummary | null,
    },
  ] as Array<{
    environmentId: string;
    label: string;
    connection?: EnvironmentConnectionPresentation;
    isConnected?: boolean;
    isPending: boolean;
    error: string | null;
    summary: UsageSummary | null;
  }>,
  execute: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.environments }));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: (...args: unknown[]) => state.execute(...args),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./presentation", () => ({
  environmentPresentations: { presentationsAtom: {} },
}));
vi.mock("./session", () => ({ environmentSession: { sessionStateAtom: vi.fn() } }));
vi.mock("./server", () => ({
  serverEnvironment: { usageSummary: (request: unknown) => request },
}));

let useUsage: (typeof import("./usage"))["useUsage"];

function UsageProbe() {
  useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return null;
}

const refreshedSummary: UsageSummary = {
  contractVersion: USAGE_CONTRACT_VERSION,
  readAt: "2026-09-01T12:00:00.000Z",
  timeZone: "America/Chicago",
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-09-01"),
  buckets: [],
  sources: [],
  pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 1,
};

const deferredSummary: UsageSummary = {
  ...refreshedSummary,
  sources: [
    {
      fingerprint: {
        hostId: "desktop",
        provider: "codex",
        resolvedHomePath: "/sessions",
        volumeId: "1",
      },
      status: "partial",
      scannedFiles: 1,
      skippedFiles: 2,
      malformedRecords: 0,
      distinctSessions: 1,
      message: "2 older or oversized transcript files deferred",
    },
  ],
};

function RefreshProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return (
    <button type="button" onClick={() => void usage.refresh()}>
      {usage.environments[0]?.summary?.readAt ?? "missing"}
    </button>
  );
}

function RefreshConnectionProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return (
    <button type="button" onClick={() => void usage.refresh()}>
      {usage.environments[0]?.connection.phase}
    </button>
  );
}

function RefreshStatusesProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return (
    <div>
      <button type="button" onClick={() => void usage.refresh()}>
        refresh
      </button>
      {usage.environments.map((environment) => (
        <span key={environment.environmentId}>
          {environment.environmentId}:
          {environment.summary?.readAt ?? environment.error ?? "pending"}
        </span>
      ))}
    </div>
  );
}

function RefreshDifferentWindowProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return (
    <button
      type="button"
      onClick={() =>
        void usage.refresh({
          sinceDay: UsageDay.make("2026-08-02"),
          untilDay: UsageDay.make("2026-09-01"),
          timeZone: "America/Chicago",
        })
      }
    >
      {usage.environments[0]?.summary?.readAt ?? "missing"}
    </button>
  );
}

function RetainPreviousProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  return (
    <button type="button" onClick={() => void usage.refresh()}>
      {usage.environments[0]?.summary?.readAt ?? "missing"}
    </button>
  );
}

function DifferentWindowResultProbe() {
  const usage = useUsage({
    sinceDay: UsageDay.make("2026-08-01"),
    untilDay: UsageDay.make("2026-09-01"),
    timeZone: "America/Chicago",
  });
  const [readAt, setReadAt] = useState("pending");
  return (
    <button
      type="button"
      onClick={() =>
        void usage
          .refresh({
            sinceDay: UsageDay.make("2026-08-02"),
            untilDay: UsageDay.make("2026-09-01"),
            timeZone: "America/Chicago",
          })
          .then((statuses) => setReadAt(statuses[0]?.summary?.readAt ?? "missing"))
      }
    >
      {readAt}
    </button>
  );
}

async function setupUsageFixture() {
  ({ useUsage } = await import("./usage"));
  state.environments = [
    {
      environmentId: "desktop",
      label: "Desktop",
      isPending: false,
      error: "This environment could not report usage.",
      summary: null,
    },
  ];
  state.execute
    .mockReset()
    .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
}

describe("usage route recovery", () => {
  it("retries a retained environment failure once when the route mounts", async () => {
    await setupUsageFixture();
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<UsageProbe />));
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        input: expect.objectContaining({ refresh: true }),
      }),
    );
    await act(async () => root.rerender(<UsageProbe />));
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it("adopts the result fetched by a manual refresh", async () => {
    await setupUsageFixture();
    state.execute.mockResolvedValue(AsyncResult.success(refreshedSummary));
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: null,
      },
    ];
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<RefreshProbe />));
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toBe(refreshedSummary.readAt);
  });

  it("keeps the current connection state when a manual refresh has cached a result", async () => {
    await setupUsageFixture();
    state.execute.mockResolvedValue(AsyncResult.success(refreshedSummary));
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        connection: { phase: "connected", error: null, traceId: null },
        isPending: false,
        error: null,
        summary: null,
      },
    ];
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<RefreshConnectionProbe />));
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toBe("connected");
    state.environments = [
      {
        ...state.environments[0]!,
        connection: { phase: "reconnecting", error: "Socket closed", traceId: null },
      },
    ];
    await act(async () => root.rerender(<RefreshConnectionProbe />));
    expect(container.textContent).toBe("reconnecting");
  });

  it("keeps the last successful summary visible when a refresh disconnects", async () => {
    await setupUsageFixture();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: refreshedSummary,
      },
    ];
    state.execute.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<RetainPreviousProbe />));
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toBe(refreshedSummary.readAt);
  });

  it("does not carry same-environment totals into a failed different-window refresh", async () => {
    await setupUsageFixture();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: refreshedSummary,
      },
    ];
    state.execute.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<DifferentWindowResultProbe />));
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toBe("missing");
  });

  it("keeps one delayed retry alive while a remote connection recovers", async () => {
    await setupUsageFixture();
    using _timers = fakeTimers();
    state.execute
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("disconnected"))))
      .mockResolvedValue(AsyncResult.success(refreshedSummary));
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<UsageProbe />));
    expect(state.execute).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(state.execute).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure while the original query is still pending", async () => {
    await setupUsageFixture();
    using _timers = fakeTimers();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: true,
        error: "This environment could not report usage.",
        summary: null,
      },
    ];
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<UsageProbe />));
    expect(state.execute).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("coalesces a delayed retry with an active same-window refresh", async () => {
    await setupUsageFixture();
    using _timers = fakeTimers();
    let finish!: (result: unknown) => void;
    state.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<UsageProbe />));
    expect(state.execute).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(state.execute).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.execute).toHaveBeenCalledTimes(2);
  });

  it("bounds retries when the deferred retry also fails slowly", async () => {
    await setupUsageFixture();
    using _timers = fakeTimers();
    const finishers: Array<(result: unknown) => void> = [];
    state.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishers.push(resolve);
        }),
    );
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<UsageProbe />));
    expect(state.execute).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(state.execute).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishers[0]?.(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.execute).toHaveBeenCalledTimes(2);

    await act(async () => {
      finishers[1]?.(AsyncResult.failure(Cause.fail(new Error("still disconnected"))));
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(30_000);
    });
    expect(state.execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    "Usage is partial because its response budget expired before this source finished.",
    "Usage is partial because the transcript inventory exceeded its response budget.",
    "Usage is partial while 1 large transcript is scanned in complete-line chunks.",
  ])("resumes an incomplete scan: %s", async (message) => {
    await setupUsageFixture();
    using _timers = fakeTimers();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        isConnected: true,
        summary: { ...deferredSummary, sources: [{ ...deferredSummary.sources[0]!, message }] },
      },
    ];
    state.execute.mockResolvedValue(AsyncResult.success(refreshedSummary));
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<UsageProbe />));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(state.execute).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated failures while the environment remains connected", async () => {
    await setupUsageFixture();
    using _timers = fakeTimers();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isConnected: true,
        isPending: false,
        error: "This environment could not report usage.",
        summary: null,
      },
    ];
    state.execute.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("unavailable"))));
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<UsageProbe />));
    for (let attempt = 0; attempt < 10; attempt++)
      await act(async () => vi.advanceTimersByTimeAsync(8_000));
    const attempts = state.execute.mock.calls.length;
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(7);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(state.execute).toHaveBeenCalledTimes(attempts);
  });

  it("keeps retrying unchanged partial reads beyond five attempts until complete", async () => {
    await setupUsageFixture();
    using _timers = fakeTimers();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        isConnected: true,
        summary: deferredSummary,
      },
    ];
    state.execute.mockResolvedValue(AsyncResult.success(deferredSummary));
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<UsageProbe />));
    for (const delay of [750, 1_500, 3_000, 6_000, 8_000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    expect(state.execute).toHaveBeenCalledTimes(5);
    state.execute.mockResolvedValue(AsyncResult.success(refreshedSummary));
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(state.execute).toHaveBeenCalledTimes(6);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(state.execute).toHaveBeenCalledTimes(6);
  });

  it("keeps warming a large deferred backlog while its count decreases", async () => {
    await setupUsageFixture();
    using _timers = fakeTimers();
    let deferredCount = 30;
    const summaryForCount = (count: number): UsageSummary => ({
      ...deferredSummary,
      sources: [
        {
          ...deferredSummary.sources[0]!,
          skippedFiles: count,
          message: `${count} older or oversized transcript files deferred`,
        },
      ],
    });
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        isConnected: true,
        summary: summaryForCount(deferredCount),
      },
    ];
    state.execute.mockImplementation(async () => {
      deferredCount -= 1;
      return AsyncResult.success(
        deferredCount > 0 ? summaryForCount(deferredCount) : refreshedSummary,
      );
    });
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<UsageProbe />));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(750));
    }
    expect(state.execute).toHaveBeenCalledTimes(30);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(state.execute).toHaveBeenCalledTimes(30);
  });

  it("cancels a scheduled deferred retry when the environment fails", async () => {
    await setupUsageFixture();
    using _timers = fakeTimers();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        isConnected: true,
        summary: deferredSummary,
      },
    ];
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<UsageProbe />));
    state.execute.mockClear();
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: "This environment could not report usage.",
        summary: deferredSummary,
      },
    ];
    await act(async () => root.rerender(<UsageProbe />));
    state.execute.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(
      state.execute.mock.calls.filter(
        ([, request]) => (request as { input?: { refresh?: boolean } }).input?.refresh === false,
      ),
    ).toHaveLength(0);
  });

  it("allows a newer shared answer to replace the manual refresh overlay", async () => {
    await setupUsageFixture();
    state.execute.mockResolvedValue(AsyncResult.success(refreshedSummary));
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: null,
      },
    ];
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<RefreshProbe />));
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toBe(refreshedSummary.readAt);

    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: { ...refreshedSummary, readAt: "2026-09-01T12:01:00.000Z" },
      },
    ];
    await act(async () => root.rerender(<RefreshProbe />));
    expect(container.textContent).toBe("2026-09-01T12:01:00.000Z");
  });

  it("publishes fast environment results while a slower refresh is pending", async () => {
    await setupUsageFixture();
    let finishSlow!: (result: unknown) => void;
    const slow = new Promise((resolve) => {
      finishSlow = resolve;
    });
    const quickSummary = { ...refreshedSummary, readAt: "2026-09-01T12:02:00.000Z" };
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: null,
      },
      {
        environmentId: "laptop",
        label: "Laptop",
        isPending: false,
        error: null,
        summary: null,
      },
    ];
    state.execute.mockImplementation((_registry: unknown, request: { environmentId: string }) =>
      request.environmentId === "desktop"
        ? Promise.resolve(AsyncResult.success(quickSummary))
        : slow,
    );
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<RefreshStatusesProbe />));
    await act(async () => container.querySelector("button")?.click());
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain("desktop:2026-09-01T12:02:00.000Z");
    expect(container.textContent).toContain("laptop:pending");

    finishSlow(AsyncResult.failure(Cause.fail(new Error("disconnected"))));
    await act(async () => slow);
    state.environments = [
      {
        environmentId: "laptop",
        label: "Laptop",
        isPending: false,
        error: null,
        summary: { ...refreshedSummary, readAt: "2026-09-01T12:03:00.000Z" },
      },
      state.environments[0]!,
    ];
    await act(async () => root.rerender(<RefreshStatusesProbe />));
    expect(container.textContent).toContain("laptop:2026-09-01T12:03:00.000Z");
  });

  it("does not show the old window while refreshing a different request key", async () => {
    await setupUsageFixture();
    state.execute.mockResolvedValue(AsyncResult.success(refreshedSummary));
    state.environments = [
      {
        environmentId: "desktop",
        label: "Desktop",
        isPending: false,
        error: null,
        summary: refreshedSummary,
      },
    ];
    const container = document.createElement("div");
    await using root = await render(null, { container, router: false });
    await act(async () => root.rerender(<RefreshDifferentWindowProbe />));
    const button = container.querySelector("button")!;
    await act(async () => button.click());
    expect(button.textContent).toBe(refreshedSummary.readAt);
  });
});
