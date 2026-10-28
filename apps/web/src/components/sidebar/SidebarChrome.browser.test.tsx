import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ navigate: vi.fn(), setOpenMobile: vi.fn(), pathname: "/" }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: "a",
  useNavigate: () => state.navigate,
  useCanGoBack: () => false,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: state.pathname }),
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
  usePullRequestsSupported: () => false,
}));
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
vi.mock("./SidebarThreadUndoNotice", () => ({ SidebarThreadUndoNotice: () => null }));

import { SidebarChromeFooter } from "./SidebarChrome";

function setup() {
  state.navigate.mockReset();
  state.setOpenMobile.mockReset();
  state.pathname = "/";
}

describe("sidebar attribution navigation", () => {
  it("opens the independent attribution page beside Usage and closes the mobile drawer", async () => {
    setup();
    await using screen = await render(<SidebarChromeFooter />);
    await expect.element(screen.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Skills & repeated input" }));
    expect(state.navigate).toHaveBeenCalledWith({ to: "/repeated-input" });
    expect(state.setOpenMobile).toHaveBeenCalledWith(false);
    state.pathname = "/repeated-input";
    await screen.rerender(<SidebarChromeFooter key="attribution" />);
    await userEvent.click(screen.getByRole("button", { name: "Back", exact: true }));
    expect(state.navigate).toHaveBeenLastCalledWith({ href: "/" });
  });
});
