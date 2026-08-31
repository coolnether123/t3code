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
  it("shows a recent-pace switch and explains why sparse or stale data cannot project", () => {
    const at = Date.parse(samples[0]!.observedAt);
    vi.spyOn(Date, "now").mockReturnValue(at);
    const sparse = renderToStaticMarkup(<UsagePaceChart samples={samples} />);
    expect(sparse).toContain('aria-label="Show recent pace"');
    expect(sparse).toContain("Waiting for an observed percentage drop and a timed interval");
    expect(sparse).not.toContain('aria-label="Recent pace projection"');
    vi.spyOn(Date, "now").mockReturnValue(at + 16 * 60_000);
    const stale = renderToStaticMarkup(<UsagePaceChart samples={samples} />);
    expect(stale).toContain("Recent pace needs a fresh reading.");
  });
  it("lets the user hide and restore the recent projection without changing recorded usage", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const at = Date.parse(samples[0]!.observedAt);
    vi.spyOn(Date, "now").mockReturnValue(at);
    const rows = Array.from({ length: 7 }, (_, index) => ({
      ...samples[0]!,
      observedAt: new Date(at - (6 - index) * 300_000).toISOString(),
      remainingPercent: [83, 82, 81, 81, 81, 81, 81][index]!,
    }));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<UsagePaceChart samples={rows} />));
      const toggle = container.querySelector<HTMLInputElement>(
        'input[aria-label="Show recent pace"]',
      )!;
      expect(toggle.checked).toBe(true);
      expect(container.querySelector('[aria-label="Recent pace projection"]')).not.toBeNull();
      expect(container.textContent).toContain("Last observed 1% drop: 5.0 min per 1%");
      expect(container.textContent).toContain(
        "No further drop for 20.0 min through the last reading",
      );
      expect(container.textContent).toContain("Projecting 1% per 20.0 min");
      expect(container.textContent).toContain("81%");
      await act(async () => toggle.click());
      expect(toggle.checked).toBe(false);
      expect(container.querySelector('[aria-label="Recent pace projection"]')).toBeNull();
      expect(container.textContent).toContain("81%");
      await act(async () => toggle.click());
      expect(container.querySelector('[aria-label="Recent pace projection"]')).not.toBeNull();
      const recorded = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Recorded",
      )!;
      await act(async () => recorded.click());
      expect(container.querySelector('[aria-label="Recent pace projection"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
