import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  presentations: new Map(),
  refreshProviders: vi.fn(async () => undefined),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.presentations }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refreshProviders }));
vi.mock("@t3tools/client-runtime/state/usage", () => ({
  refreshUsageLimits: async (_environmentId: string, refresh: () => Promise<void>) => refresh(),
}));
vi.mock("../../state/usage", () => ({
  useUsage: () => ({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments: [],
    isPending: false,
    refresh: vi.fn(async () => undefined),
  }),
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", () => ({ Link: "a", useNavigate: () => vi.fn() }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuCheckboxItem: "div",
  MenuItem: "div",
  MenuPopup: "div",
  MenuSeparator: "hr",
  MenuTrigger: "div",
}));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("../BirthdayCelebration", () => ({ BirthdayGreeting: () => null }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: () => null }));
vi.mock("./UsageModelHourlyChart", () => ({ UsageModelHourlyChart: () => null }));
vi.mock("./CodexUsageButton", () => ({ CodexUsageButton: () => null }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("./UsageLimits", () => ({
  UsageLimitsSection: ({ now }: { readonly now: number }) => `limits-now:${now}`,
}));

import { UsagePage } from "./UsagePage";

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  state.refreshProviders.mockClear();
  state.presentations = new Map([
    [
      EnvironmentId.make("limits-test"),
      {
        connection: { phase: "connected" },
        serverConfig: { providers: [] },
      },
    ],
  ]);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("refreshes connected limits when the page opens and re-anchors them on manual refresh", async () => {
  await act(() => {
    renderer = create(<UsagePage />);
  });
  expect(state.refreshProviders).toHaveBeenCalledWith({
    environmentId: "limits-test",
    input: {},
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("limits-now:1000000");

  vi.mocked(Date.now).mockReturnValue(1_030_000);
  const refreshButton = renderer.root.findAllByProps({ "aria-label": "Refresh usage" })[0]!;
  await act(async () => {
    refreshButton.props.onClick();
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("limits-now:1030000");
});

it("continues refreshing other environments when one provider refresh rejects", async () => {
  state.presentations.set(EnvironmentId.make("limits-test-2"), {
    connection: { phase: "connected" },
    serverConfig: { providers: [] },
  });
  state.refreshProviders.mockRejectedValueOnce(new Error("offline"));

  await act(async () => {
    renderer = create(<UsagePage />);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(state.refreshProviders).toHaveBeenCalledTimes(2);
});
