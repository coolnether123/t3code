/** @vitest-environment happy-dom */
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ navigate: vi.fn(), setOpenMobile: vi.fn(), pathname: "/" }));
vi.mock("@tanstack/react-router", () => ({
  Link: "a",
  useNavigate: () => state.navigate,
  useCanGoBack: () => false,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: state.pathname }),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../ui/sidebar", () => ({
  SidebarFooter: "footer",
  SidebarHeader: "header",
  SidebarMenu: "div",
  SidebarMenuButton: "button",
  SidebarMenuItem: "div",
  SidebarTrigger: "button",
  useSidebar: () => ({ isMobile: true, setOpenMobile: state.setOpenMobile }),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipPopup: "span",
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
}));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => null,
  SidebarUpdateArchitectureWarning: () => null,
}));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));

import { SidebarUtilityMenu } from "./SidebarChrome";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.pathname = "/";
});

describe("sidebar attribution navigation", () => {
  it("opens the independent attribution page beside Usage and closes the mobile drawer", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<SidebarUtilityMenu />));
      expect(container.querySelector('[aria-label="Usage"]')).not.toBeNull();
      const attribution = container.querySelector<HTMLButtonElement>(
        '[aria-label="Skills & repeated input"]',
      )!;
      expect(attribution).not.toBeNull();
      await act(async () => attribution.click());
      expect(state.navigate).toHaveBeenCalledWith({ to: "/repeated-input" });
      expect(state.setOpenMobile).toHaveBeenCalledWith(false);
      state.pathname = "/repeated-input";
      await act(async () => root.render(<SidebarUtilityMenu key="attribution" />));
      expect(container.textContent).toContain("Back");
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      expect(state.navigate).toHaveBeenLastCalledWith({ to: "/" });
    } finally {
      await act(async () => root.unmount());
    }
  });
});
