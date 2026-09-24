/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { UsageActivityPanel } from "./UsageActivityPanel";
import { quotaActivityPoints, type ChartActivity } from "./usageChartActivity";

const start = Date.parse("2026-09-01T00:00:00Z");
const end = start + 7_200_000;
const totals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 100,
  reasoningTokens: 0,
};
const activity: ChartActivity[] = [
  {
    interval: {
      id: "first",
      sinceTime: new Date(start).toISOString(),
      untilTime: new Date(start + 3_600_000).toISOString(),
    },
    models: [{ model: "gpt-6-astra", costUsd: 90, unpricedRecords: 0, totals }],
  },
  {
    interval: {
      id: "second",
      sinceTime: new Date(start + 3_600_000).toISOString(),
      untilTime: new Date(end).toISOString(),
    },
    models: [{ model: "gpt-6-sol", costUsd: 10, unpricedRecords: 0, totals }],
  },
];
const points = quotaActivityPoints(
  [
    {
      observedAt: new Date(start).toISOString(),
      remainingPercent: 90,
      resetsAt: "2026-09-08T00:00:00Z",
    },
    {
      observedAt: new Date(end).toISOString(),
      remainingPercent: 80,
      resetsAt: "2026-09-08T00:00:00Z",
    },
  ],
  activity,
);

describe("usage activity explorer", () => {
  it("shows meaningful rates and concentration without treating API value as a bill", () => {
    const markup = renderToStaticMarkup(
      <UsageActivityPanel
        activity={activity}
        points={points}
        start={start}
        end={end}
        onZoom={() => {}}
      />,
    );
    expect(markup).toContain("$100.00");
    expect(markup).toContain("$45.00");
    expect(markup).toContain("$50.00");
    expect(markup).toContain("1.8×");
    expect(markup).toContain("45% of API value");
    expect(markup).toContain("9.00 quota points");
    expect(markup).toContain('viewBox="0 0 960 120"');
    expect(markup).toContain('width="479"');
  });
  it("switches model and spike views, inspects by touch and zooms the chosen interval", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const zoom = vi.fn();
    const reset = vi.fn();
    const button = (label: string) =>
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)!;
    try {
      await act(async () =>
        root.render(
          <UsageActivityPanel
            activity={activity}
            points={points}
            start={start}
            end={end}
            onZoom={zoom}
            onResetZoom={reset}
          />,
        ),
      );
      await act(async () => button("Models").click());
      expect(container.querySelector('[aria-label="Model cost shares"]')?.textContent).toContain(
        "90%",
      );
      const plot = container.querySelector("svg")!;
      plot.setPointerCapture = vi.fn();
      vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
      expect(container.querySelector('input[aria-label="Inspect API activity"]')).toBeNull();
      await act(async () =>
        plot.dispatchEvent(
          new PointerEvent("pointerdown", { clientX: 75, pointerType: "touch", bubbles: true }),
        ),
      );
      expect(
        container.querySelector('[aria-label="Selected activity interval"]')?.textContent,
      ).toContain("1.00 quota points");
      await act(async () => button("Zoom here").click());
      expect(zoom).toHaveBeenLastCalledWith(start + 3_600_000, end);
      await act(async () =>
        plot.dispatchEvent(new PointerEvent("pointermove", { clientX: 95, bubbles: true })),
      );
      await act(async () =>
        plot.dispatchEvent(new PointerEvent("pointerup", { clientX: 95, bubbles: true })),
      );
      expect(zoom).toHaveBeenLastCalledWith(
        start + 0.75 * (end - start),
        start + 0.95 * (end - start),
      );
      await act(async () => plot.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
      expect(reset).toHaveBeenCalledOnce();
      await act(async () => button("Spikes").click());
      const spikes = container.querySelector('[aria-label="Highest spending intervals"]')!;
      expect(spikes.querySelector("button")?.textContent).toContain("gpt-6-astra");
      await act(async () => spikes.querySelector("button")!.click());
      expect(button("Intensity").getAttribute("aria-pressed")).toBe("true");
      expect(
        container.querySelector('[aria-label="Selected activity interval"]')?.textContent,
      ).toContain("9.00 quota points");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
  it("withholds aggregate insights when an interval is missing", () => {
    const markup = renderToStaticMarkup(
      <UsageActivityPanel
        activity={[{ ...activity[0]!, models: null }, activity[1]!]}
        points={points}
        start={start}
        end={end}
        onZoom={() => {}}
      />,
    );
    expect(markup).toContain("Reading activity");
    expect(markup).not.toContain("45% of API value");
    expect(markup).not.toContain("$100.00");
  });
});
