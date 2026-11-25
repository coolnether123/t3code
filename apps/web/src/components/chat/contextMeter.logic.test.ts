import { expect, it } from "vite-plus/test";
import { resolveContextMeter } from "./contextMeter.logic";

it.each([
  { used: 165_217, max: 1_000_000, threshold: 667_000, tone: null, remaining: 501_783 },
  { used: 643_000, max: 1_000_000, threshold: 667_000, tone: "warning", remaining: 24_000 },
  { used: 677_000, max: 1_000_000, threshold: 667_000, tone: "warning", remaining: 0 },
  { used: 90_852, max: 1_000_000, threshold: 667_000, tone: null, remaining: 576_148 },
  { used: 179_059, max: 475_000, threshold: null, tone: null, remaining: null },
  { used: 800_000, max: 1_000_000, threshold: null, tone: "warning", remaining: null },
  { used: 900_000, max: 1_000_000, threshold: null, tone: "error", remaining: null },
  { used: 26_077, max: null, threshold: null, tone: null, remaining: null },
])(
  "tones context at $used of $max, with compaction at $threshold",
  ({ used, max, threshold, tone, remaining }) => {
    expect(
      resolveContextMeter({ usedTokens: used, maxTokens: max, autoCompactThreshold: threshold }),
    ).toMatchObject({ tone, remaining });
  },
);
