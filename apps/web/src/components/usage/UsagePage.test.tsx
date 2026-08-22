import { describe, expect, it } from "vite-plus/test";

import usagePageSource from "./UsagePage.tsx?raw";

describe("UsagePage mobile range controls", () => {
  it("keeps every range, including one year, visible in a bounded mobile grid", () => {
    expect(usagePageSource).toContain('{ days: 365, label: "1 year" }');
    expect(usagePageSource).toContain("data-usage-window-options");
    expect(usagePageSource).toContain("grid-cols-3");
    expect(usagePageSource).toContain("sm:flex sm:flex-none");
    expect(usagePageSource).toContain("w-full min-w-0");
  });
});
