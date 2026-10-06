/** @vitest-environment happy-dom */
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ComputerMenu } from "./ComputerMenu";

vi.mock("../../uiStateStore", () => ({ ALL_ENVIRONMENTS_CHAT_LOCATION_SCOPE: "all" }));
vi.mock("../ui/sidebar", () => ({
  SidebarMenuButton: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../../state/environments", () => ({ useEnvironment: () => null }));

const environments = [
  { environmentId: EnvironmentId.make("computer-a"), label: "Example A", color: "#123abc" },
  { environmentId: EnvironmentId.make("computer-b"), label: "Example B", color: "#654321" },
];

afterEach(() => vi.unstubAllGlobals());

describe("computer menu", () => {
  it("shows names and colors in the trigger and choices, and keeps switching and All computers", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    try {
      await act(async () =>
        root.render(
          <ComputerMenu
            environments={environments}
            selectedEnvironmentId={environments[0]!.environmentId}
            onSelect={onSelect}
          />,
        ),
      );
      const trigger = container.querySelector<HTMLButtonElement>(
        '[aria-label="Browse computers"]',
      )!;
      expect(trigger.textContent).toContain("Example A");
      expect(trigger.querySelector<HTMLElement>("[aria-hidden=true]")!.style.backgroundColor).toBe(
        "#123abc",
      );
      await act(async () => trigger.click());
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      expect(items.map((item) => item.textContent?.trim())).toEqual([
        "Example A",
        "Example B",
        "All computers",
      ]);
      expect(
        items[1]!.querySelector<HTMLElement>("[data-computer-name] [aria-hidden=true]")!.style
          .backgroundColor,
      ).toBe("#654321");
      await act(async () => items[1]!.click());
      expect(onSelect.mock.calls[0]![0]).toBe("computer-b");

      await act(async () =>
        root.render(
          <ComputerMenu
            environments={environments}
            selectedEnvironmentId={null}
            onSelect={onSelect}
          />,
        ),
      );
      expect(trigger.textContent).toContain("All computers");
      await act(async () => trigger.click());
      const allItem = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (item) => item.textContent?.includes("All computers"),
      )!;
      await act(async () => allItem.click());
      expect(onSelect.mock.calls.at(-1)![0]).toBe("all");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
