import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: "a" as never,
  useNavigate: (() => testState.navigate) as never,
}));
vi.mock(import("../../state/usage"), async (original) => ({
  ...(await original()),
  useUsage: testState.useUsage,
}));

import { UsagePage } from "./UsagePage";
const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    canReadDiagnostics: true,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00.000Z",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      timeZone: "UTC",
      buckets: [],
      sources: [],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  },
];

function setup() {
  testState.navigate.mockReset();
  testState.useUsage.mockReset().mockReturnValue({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments,
    selectedEnvironments: environments,
    isPending: false,
    shown: null,
    isPartial: false,
    refresh: vi.fn(),
  });
}

describe("UsagePage modal dismissal", () => {
  it.each([390, 1440])("closes Usage on Escape at width %s", async (width) => {
    setup();
    await page.viewport(width, 900);
    await using _screen = await render(<UsagePage />);
    await expect.element(page.getByRole("dialog", { name: "Usage" })).toBeVisible();
    await page.screenshot({ path: `__screenshots__/usage-modal-${width}.png` });
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(testState.navigate).toHaveBeenCalledWith({ href: "/" }));
  });

  it("closes Usage from its close button", async () => {
    setup();
    await using _screen = await render(<UsagePage />);
    await userEvent.click(page.getByRole("button", { name: "Close", exact: true }));
    await vi.waitFor(() => expect(testState.navigate).toHaveBeenCalledWith({ href: "/" }));
  });

  it("closes the environment menu before Escape closes Usage", async () => {
    setup();
    await using _screen = await render(<UsagePage />);
    await expect.element(page.getByRole("dialog", { name: "Usage" })).toBeVisible();
    const trigger = document.querySelector<HTMLButtonElement>('[data-slot="menu-trigger"]')!;
    await userEvent.click(trigger);
    await expect.element(page.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(testState.navigate).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(testState.navigate).toHaveBeenCalledWith({ href: "/" }));
  });
});
