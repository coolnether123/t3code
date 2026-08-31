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
});
