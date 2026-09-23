/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { UsagePaceChart } from "./UsagePaceChart";

afterEach(() => vi.restoreAllMocks());
describe("weekly pace chart", () => {
  const samples = [
    {
      observedAt: "2026-08-31T00:00:00.000Z",
      remainingPercent: 80,
      resetsAt: "2026-09-06T00:00:00.000Z",
    },
  ];
  it("zooms, pans and restores the complete cycle with keyboard and buttons", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onRangeChange = vi.fn();
    const rows = [
      samples[0]!,
      { ...samples[0]!, observedAt: "2026-09-02T00:00:00.000Z", remainingPercent: 40 },
    ];
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(rows[1]!.observedAt));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<UsagePaceChart samples={rows} onRangeChange={onRangeChange} />),
      );
      const button = (label: string) =>
        Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)!;
      await act(async () => button("6h").click());
      const range = onRangeChange.mock.lastCall![0] as [number, number];
      expect(range[1] - range[0]).toBe(6 * 3_600_000);
      expect(container.querySelector('[aria-label="Visible chart range"]')).not.toBeNull();
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Pan earlier"]')!.click(),
      );
      expect(onRangeChange.mock.lastCall![0][0]).toBeLessThan(range[0]);
      const plot = container.querySelector('svg[role="img"]')!;
      await act(async () =>
        plot.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true })),
      );
      expect(onRangeChange.mock.lastCall![0][1] - onRangeChange.mock.lastCall![0][0]).toBe(
        3 * 3_600_000,
      );
      await act(async () =>
        plot.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(onRangeChange.mock.lastCall![0]).toBeNull();
      expect(container.querySelector('[aria-label="Visible chart range"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
  it("zooms a dragged range and clears it when moving to another reset cycle", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onRangeChange = vi.fn();
    const rows = [
      samples[0]!,
      { ...samples[0]!, observedAt: "2026-09-02T00:00:00.000Z", remainingPercent: 40 },
      {
        observedAt: "2026-09-03T00:00:00.000Z",
        remainingPercent: 100,
        resetsAt: "2026-09-10T00:00:00.000Z",
      },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<UsagePaceChart samples={rows} onRangeChange={onRangeChange} />),
      );
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Previous reset cycle"]')!.click(),
      );
      const plot = container.querySelector<SVGSVGElement>('svg[role="img"]')!;
      plot.setPointerCapture = vi.fn();
      vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
      await act(async () =>
        plot.dispatchEvent(
          new PointerEvent("pointerdown", { clientX: 25, button: 0, bubbles: true }),
        ),
      );
      await act(async () =>
        plot.dispatchEvent(new PointerEvent("pointermove", { clientX: 75, bubbles: true })),
      );
      await act(async () =>
        plot.dispatchEvent(new PointerEvent("pointerup", { clientX: 75, bubbles: true })),
      );
      expect(onRangeChange.mock.lastCall![0][1] - onRangeChange.mock.lastCall![0][0]).toBe(
        36 * 3_600_000,
      );
      expect(container.querySelector('[aria-label="Visible chart range"]')).not.toBeNull();
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Next reset cycle"]')!.click(),
      );
      expect(container.querySelector('[aria-label="Visible chart range"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
  it("renders quota, target, projection and time without transcript costs", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(samples[0]!.observedAt));
    const markup = renderToStaticMarkup(<UsagePaceChart samples={samples} />);
    expect(markup).toContain("80%");
    expect(markup).toContain("Pace to reset");
    expect(markup).toContain("used this cycle");
    expect(markup).toContain("Runs out before reset");
    expect(markup).toContain("Updated");
    expect(markup).toContain("4d 0h");
    expect(markup).toContain("Codex remaining usage and pace to next reset");
    expect(markup).not.toContain("Unavailable");
  });
  it("does not show a stale reading as a live forecast", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(samples[0]!.observedAt) + 16 * 60_000);
    const markup = renderToStaticMarkup(<UsagePaceChart samples={samples} />);
    expect(markup).toContain("Reading is stale");
    expect(markup).toContain("Last run-out estimate");
    expect(markup).not.toContain("4d 0h at this pace");
  });
  it("connects earlier monitoring runs in the same cycle without changing measured use", () => {
    const rows = [
      { ...samples[0]!, observedAt: "2026-08-31T00:00:00.000Z", remainingPercent: 90 },
      { ...samples[0]!, observedAt: "2026-09-02T00:00:00.000Z", remainingPercent: 50 },
      { ...samples[0]!, observedAt: "2026-09-02T01:00:00.000Z", remainingPercent: 49 },
    ];
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(rows[2]!.observedAt));
    const markup = renderToStaticMarkup(<UsagePaceChart samples={rows} />);
    const container = document.createElement("div");
    container.innerHTML = markup;
    const path = container.querySelector('[aria-label="Recorded usage ahead of pace"]')!;
    expect(path.getAttribute("d")?.match(/M/g)).toHaveLength(1);
    expect(path.getAttribute("d")?.match(/L/g)).toHaveLength(2);
    expect(container.textContent).toContain("captured a 1-point drop");
    expect(
      container.querySelector('input[aria-label="Inspect recorded usage"]')?.getAttribute("max"),
    ).toBe("2");
    expect(container.querySelector("details")?.open).toBe(false);
  });
  it("accepts a new reading between clock ticks without a stale warning", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    const started = Date.parse(samples[0]!.observedAt);
    vi.setSystemTime(started);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsagePaceChart samples={samples} />));
      vi.setSystemTime(started + 20_000);
      const refreshed = [
        ...samples,
        { ...samples[0]!, observedAt: new Date(Date.now()).toISOString(), remainingPercent: 79 },
      ];
      await act(async () => root.render(<UsagePaceChart samples={refreshed} />));
      expect(container.textContent).toContain("79%");
      expect(container.textContent).toContain("Updated");
      expect(container.textContent).not.toContain("Reading is stale");
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it("uses an announced deadline without claiming usage was reset", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(samples[0]!.observedAt));
    const markup = renderToStaticMarkup(
      <UsagePaceChart
        samples={samples}
        news={{
          status: "ready",
          checkedAt: Date.now(),
          announcement: {
            publishedAt: "2026-08-30T20:00:00Z",
            targetAt: "2026-08-31T01:00:00Z",
            validUntil: "2026-08-31T00:30:00Z",
            sourceUrl: "https://x.com/thsottiaux/status/2094144275957350900",
            quote: "Codex reset at 6pm PST",
          },
        }}
      />,
    );
    expect(markup).toContain("Announced reset");
    expect(markup).toContain("80%");
    expect(markup).toContain("20%");
    expect(markup).toContain("77.0");
    expect(markup).toContain("Account weekly timer");
    expect(markup).toContain("not account confirmation");
    expect(markup).toContain('href="https://x.com/thsottiaux/status/2094144275957350900"');
  });
  it("shows an API-cost switch and explains why incomplete or stale data cannot project", () => {
    const at = Date.parse(samples[0]!.observedAt);
    vi.spyOn(Date, "now").mockReturnValue(at);
    const sparse = renderToStaticMarkup(<UsagePaceChart samples={samples} />);
    expect(sparse).toContain('aria-label="Show API cost pace"');
    expect(sparse).toContain("complete, priced costs");
    expect(sparse).not.toContain('aria-label="API cost projection"');
    vi.spyOn(Date, "now").mockReturnValue(at + 16 * 60_000);
    const stale = renderToStaticMarkup(<UsagePaceChart samples={samples} />);
    expect(stale).toContain("API cost pace needs a fresh account reading.");
  });
  it("lets the user hide and restore the API projection without changing recorded usage", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const at = Date.parse(samples[0]!.observedAt);
    vi.spyOn(Date, "now").mockReturnValue(at);
    const rows = Array.from({ length: 7 }, (_, index) => ({
      ...samples[0]!,
      observedAt: new Date(at - (6 - index) * 3_600_000).toISOString(),
      remainingPercent: [83, 82, 81, 81, 81, 81, 81][index]!,
    }));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <UsagePaceChart
            samples={rows}
            apiPace={{
              interval: {
                id: "pace",
                sinceTime: rows[0]!.observedAt,
                untilTime: rows.at(-1)!.observedAt,
              },
              remainingValueUsd: 50,
              models: [
                {
                  model: "gpt-5.6-luna",
                  costUsd: 60,
                  unpricedRecords: 0,
                  totals: {
                    uncachedInputTokens: 0,
                    cachedInputTokens: 0,
                    cacheCreationTokens: 0,
                    outputTokens: 50e6,
                    reasoningTokens: 0,
                  },
                },
              ],
            }}
            manualResets={{ availableCount: 3, verified: true }}
          />,
        ),
      );
      const toggle = container.querySelector<HTMLInputElement>(
        'input[aria-label="Show API cost pace"]',
      )!;
      expect(toggle.checked).toBe(true);
      expect(container.querySelector('[aria-label="API cost projection"]')).not.toBeNull();
      expect(container.textContent).toContain("$10.00/hour over the last 6.0 hours");
      expect(container.textContent).toContain("Empty in 5h 0m");
      expect(container.textContent).toContain("81%");
      expect(container.textContent).toContain("Banked manual resets");
      expect(container.textContent).toContain("3 available");
      await act(async () => toggle.click());
      expect(toggle.checked).toBe(false);
      expect(container.querySelector('[aria-label="API cost projection"]')).toBeNull();
      expect(container.textContent).toContain("81%");
      await act(async () => toggle.click());
      expect(container.querySelector('[aria-label="API cost projection"]')).not.toBeNull();
      const recorded = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Recorded",
      )!;
      await act(async () => recorded.click());
      expect(container.querySelector('[aria-label="API cost projection"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
  it("uses time-positioned future hit testing and returns to recorded values with keyboard", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const at = Date.parse("2026-08-31T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(at + 30 * 60_000);
    const rows = [
      {
        ...samples[0]!,
        observedAt: new Date(at - 6 * 3_600_000).toISOString(),
        remainingPercent: 90,
      },
      {
        ...samples[0]!,
        observedAt: new Date(at - 30 * 60_000).toISOString(),
        remainingPercent: 80,
      },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsagePaceChart samples={rows} />));
      const plot = container.querySelector('svg[role="img"]')!;
      vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 100,
        height: 200,
        right: 100,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      await act(async () =>
        plot.dispatchEvent(new PointerEvent("pointermove", { clientX: 95, bubbles: true })),
      );
      const tooltip = container.querySelector('[role="status"].pointer-events-none')!;
      expect(tooltip.textContent).toContain("Projection");
      expect(container.textContent).toContain("target");
      await act(async () =>
        plot.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
      );
      expect(tooltip.textContent).toContain("Recorded");
      expect(tooltip.textContent).not.toContain("Projection");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
  it("browses saved cycles one at a time and returns to the live cycle", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const rows = [
      { ...samples[0]!, observedAt: "2026-08-30T00:00:00.000Z", remainingPercent: 70 },
      { ...samples[0]!, observedAt: "2026-08-30T02:00:00.000Z", remainingPercent: 50 },
      {
        observedAt: "2026-08-30T03:00:00.000Z",
        remainingPercent: 100,
        resetsAt: "2026-09-06T03:00:00.000Z",
      },
      {
        observedAt: "2026-08-30T05:00:00.000Z",
        remainingPercent: 90,
        resetsAt: "2026-09-06T03:00:00.000Z",
      },
      {
        observedAt: "2026-08-30T06:00:00.000Z",
        remainingPercent: 100,
        resetsAt: "2026-09-06T06:00:00.000Z",
      },
      {
        observedAt: "2026-08-30T08:00:00.000Z",
        remainingPercent: 80,
        resetsAt: "2026-09-06T06:00:00.000Z",
      },
    ];
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(rows.at(-1)!.observedAt));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <UsagePaceChart samples={rows} manualResets={{ availableCount: 3, verified: true }} />,
        ),
      );
      const previous = container.querySelector<HTMLButtonElement>(
        '[aria-label="Previous reset cycle"]',
      )!;
      const next = container.querySelector<HTMLButtonElement>('[aria-label="Next reset cycle"]')!;
      expect(next.disabled).toBe(true);
      expect(
        container.querySelector('[aria-label="Ahead of pace area"]')?.getAttribute("d"),
      ).toContain("Z");
      expect(
        container.querySelector('[aria-label="Behind pace area"]')?.getAttribute("d"),
      ).toContain("Z");
      await act(async () => previous.click());
      expect(container.textContent).toContain("Cycle 2 of 3");
      expect(container.textContent).toContain("90%");
      const historicalPace = container.querySelector('[aria-label="Pace to observed reset"]')!;
      expect(historicalPace.getAttribute("x2")).toBe("960");
      expect(historicalPace.getAttribute("y2")).toBe("196");
      expect(container.querySelector('[aria-label="Observed reset boundary"]')).not.toBeNull();
      const recordedPath = container
        .querySelector('[aria-label="Recorded usage ahead of pace"]')!
        .getAttribute("d")!;
      expect(recordedPath).toContain("L640,");
      expect(container.textContent).not.toContain("Daily budget");
      expect(container.textContent).not.toContain("Banked resets");
      expect(container.textContent).not.toContain("Weekly reset");
      await act(async () => previous.click());
      expect(container.textContent).toContain("Cycle 1 of 3");
      expect(previous.disabled).toBe(true);
      expect(container.textContent).toContain("50%");
      await act(async () => next.click());
      expect(container.textContent).toContain("Cycle 2 of 3");
      const current = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Current",
      )!;
      await act(async () => current.click());
      expect(container.textContent).toContain("Current cycle");
      expect(container.querySelector('[aria-label="Pace to observed reset"]')).toBeNull();
      expect(container.querySelector('[aria-label="Weekly pace"]')).not.toBeNull();
      expect(container.textContent).toContain("80%");
      expect(next.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
