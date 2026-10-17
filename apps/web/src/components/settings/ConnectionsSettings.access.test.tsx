/** @vitest-environment happy-dom */
import { type ReactElement } from "react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  scopes: [] as ReadonlyArray<AuthEnvironmentScope>,
  policy: "loopback-only",
  copied: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => {},
    useId: () => "test-qr",
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ status: "idle" }) }));
vi.mock("../../environments/primary", async () => ({
  isLoopbackHostname: (await import("../../environments/primary/target")).isLoopbackHostname,
  usePrimarySessionState: () => ({
    data: { authenticated: true, scopes: state.scopes, auth: { policy: state.policy } },
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/server", () => ({
  primaryServerKeybindingsAtom: {},
  serverEnvironment: { updateStateAtom: () => null },
}));
vi.mock("../../state/auth", () => ({ authEnvironment: {} }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false, error: null, refresh: vi.fn() }),
}));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../connection/onboarding", () => ({ connectPairing: {}, connectSshEnvironment: {} }));
vi.mock("../../state/desktopNetworkAccess", () => ({}));
vi.mock("../../state/desktopSshHosts", () => ({ filterDiscoveredSshHosts: () => [] }));
vi.mock("../../state/desktopWslState", () => ({}));
vi.mock("../../uiStateStore", () => ({
  useUiStateStore: (select: (value: object) => unknown) => select({}),
}));
vi.mock("./EnvironmentIconPicker", () => ({ EnvironmentIconPicker: () => null }));
vi.mock("./LoadBalancingSettings", () => ({ LoadBalancingSettings: () => null }));
vi.mock("../ServerUpdateAction", () => ({}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({}));
vi.mock("../../cloud/useCloudLinkController", () => ({}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: state.copied }),
}));

import { ConnectionsSettings } from "./ConnectionsSettings";

function renderSettings() {
  hooks.beginRender();
  return ConnectionsSettings();
}

function renderMemo(element: ReactElement<Record<string, unknown>>) {
  hooks.beginRender();
  const component = element.type as unknown as {
    type: (props: Record<string, unknown>) => ReactElement;
  };
  return component.type(element.props);
}

describe("connection access management behind a reverse proxy", () => {
  beforeEach(() => {
    hooks.reset();
    state.policy = "loopback-only";
    state.scopes = [...AuthStandardClientScopes, AuthAccessReadScope, AuthAccessWriteScope];
    state.copied.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("offers Create link for an owner even with loopback binding and no desktop endpoints", () => {
    const tree = renderSettings();
    const section = visitElements(tree, (element) => element.props.title === "Authorized clients");
    expect(section).not.toBeNull();
    const header = section!.props.headerAction as ReactElement<Record<string, unknown>>;
    hooks.reset();
    const headerTree = renderMemo(header);
    expect(
      visitElements(headerTree, (element) => {
        const children = element.props.children;
        return Array.isArray(children) && children.includes("Create link");
      }),
    ).not.toBeNull();
    expect(
      visitElements(
        tree,
        (element) =>
          typeof element.props.description === "string" &&
          element.props.description.includes("configured reverse proxy"),
      ),
    ).not.toBeNull();
  });

  it("copies a share link on the current HTTPS proxy origin without desktop endpoints", () => {
    vi.stubGlobal("window", {
      location: new URL("https://example.tailnet.test/settings/connections?ignored=value#old"),
      isSecureContext: true,
    });
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    const tree = renderSettings();
    const list = visitElements(tree, (element) => "createdPairingCredentials" in element.props)!;
    const pairingLink = {
      id: "fixture-link",
      label: "Test client",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: AuthStandardClientScopes,
    };
    hooks.reset();
    const listTree = renderMemo({
      ...list,
      props: {
        ...list.props,
        pairingLinks: [pairingLink],
        createdPairingCredentials: new Map([[pairingLink.id, "PAIRCODE"]]),
      },
    });
    const row = visitElements(listTree, (element) => element.props.credential === "PAIRCODE")!;
    hooks.reset();
    const rowTree = renderMemo(row);
    const share = visitElements(rowTree, (element) => "aria-controls" in element.props)!;
    (share.props.onClick as () => void)();
    const expandedRow = renderMemo(row);
    const copy = visitElements(expandedRow, (element) => element.props.children === "Copy link")!;
    (copy.props.onClick as () => void)();
    expect(state.copied).toHaveBeenCalledWith("https://example.tailnet.test/pair#token=PAIRCODE", {
      value: "https://example.tailnet.test/pair#token=PAIRCODE",
      kind: "link",
    });
  });

  it.each(["loopback-only", "remote-reachable"])(
    "keeps access management hidden for standard scopes with %s binding",
    (policy) => {
      state.policy = policy;
      state.scopes = AuthStandardClientScopes;
      const tree = renderSettings();
      expect(
        visitElements(tree, (element) => element.props.title === "Authorized clients"),
      ).toBeNull();
      expect(
        visitElements(tree, (element) => element.props.title === "Administrative access"),
      ).not.toBeNull();
    },
  );
});
