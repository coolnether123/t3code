/** @vitest-environment happy-dom */

import { StrictMode, act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { getPairingTokenFromUrl, stripPairingTokenFromUrl } from "../../pairingUrl";
import { addComputerHash, readAddComputerLink } from "../../connection/addComputerLink";
import { PairingRouteSurface } from "./PairingRouteSurface";
import { AddComputerLinkPrompt } from "../AddComputerLinkPrompt";
import { Route } from "../../routes/pair";

const state = vi.hoisted(() => ({
  href: "/pair",
  listeners: new Set<() => void>(),
  submit: vi.fn<(...args: string[]) => Promise<void>>(),
  connect: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  navigate: vi.fn(),
}));
const auth = {
  policy: "desktop-managed-local",
  bootstrapMethods: ["desktop-bootstrap"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
} as const;

vi.mock("@tanstack/react-router", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useLocation: ({ select }: { select: (location: { href: string }) => unknown }) => {
      const href = useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.href,
      );
      return select({ href });
    },
    useNavigate: () => state.navigate,
    createFileRoute: () => (options: object) => ({
      options,
      useRouteContext: () => ({ authGateState: { status: "requires-auth", auth } }),
    }),
  };
});
vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: () => getPairingTokenFromUrl(new URL(window.location.href)),
  stripPairingTokenFromUrl: () => {
    window.history.replaceState(
      window.history.state,
      "",
      stripPairingTokenFromUrl(new URL(window.location.href)),
    );
  },
  submitServerAuthCredential: (token: string) => state.submit(token),
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.connect }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: state.confirm }));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({
  Input: ({
    nativeInput: _native,
    ...props
  }: ComponentProps<"input"> & { nativeInput: boolean }) => <input {...props} />,
}));

let root: Root;
let container: HTMLDivElement;
const authenticated = vi.fn();
const otherLink = "https://other.example.test/pair#token=synthetic-other";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({}, "", "/pair");
  state.href = "/pair";
  state.submit.mockReset().mockResolvedValue(undefined);
  state.connect.mockReset().mockResolvedValue({ _tag: "Success" });
  state.confirm.mockReset().mockResolvedValue(true);
  state.toast.mockReset();
  state.navigate.mockReset();
  authenticated.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderPairing() {
  await act(async () => {
    root.render(
      <StrictMode>
        <PairingRouteSurface auth={auth} onAuthenticated={authenticated} />
      </StrictMode>,
    );
  });
}

async function incoming(hash: string, event: "hashchange" | "popstate" = "hashchange") {
  await act(async () => {
    window.history.replaceState(window.history.state, "", `/pair#${hash}`);
    window.dispatchEvent(new Event(event));
  });
}

describe("same-page pairing links", () => {
  it("automatically consumes a token opened after the empty pairing page mounted", async () => {
    await renderPairing();
    expect(state.submit).not.toHaveBeenCalled();
    await incoming(`token=synthetic-first&${addComputerHash(otherLink)}`);
    expect(state.submit).toHaveBeenCalledExactlyOnceWith("synthetic-first");
    expect(authenticated).toHaveBeenCalledOnce();
    expect(getPairingTokenFromUrl(new URL(window.location.href))).toBeNull();
    expect(readAddComputerLink(new URL(window.location.href))).toBe(otherLink);
  });

  it("does not replay a failed token across events, rerenders or StrictMode effects", async () => {
    state.submit.mockRejectedValue(new Error("Expired pairing link"));
    window.history.replaceState({}, "", "/pair#token=synthetic-expired");
    await renderPairing();
    await incoming("token=synthetic-expired");
    await incoming("token=synthetic-expired", "popstate");
    await renderPairing();
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Expired pairing link");
    expect(authenticated).not.toHaveBeenCalled();
    expect(container.querySelector("input")?.value).toBe("");
    state.submit.mockResolvedValue(undefined);
    await incoming("token=synthetic-replacement");
    expect(state.submit).toHaveBeenCalledTimes(2);
    expect(authenticated).toHaveBeenCalledOnce();
  });

  it("serializes rapid distinct tokens and ignores duplicate arrivals while pending", async () => {
    let rejectFirst!: (error: Error) => void;
    state.submit.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    await renderPairing();
    await incoming("token=synthetic-slow");
    await incoming("token=synthetic-slow");
    await incoming("token=synthetic-next");
    expect(state.submit).toHaveBeenCalledTimes(1);
    await act(async () => rejectFirst(new Error("Expired pairing link")));
    expect(state.submit.mock.calls.map(([token]) => token)).toEqual([
      "synthetic-slow",
      "synthetic-next",
    ]);
    expect(authenticated).toHaveBeenCalledOnce();
  });

  it("observes router-only hash navigation and carries the new combined link after sign-in", async () => {
    const PairRouteView = Route.options.component!;
    await act(async () => root.render(<PairRouteView />));
    window.history.pushState({}, "", `/pair#token=synthetic-routed&${addComputerHash(otherLink)}`);
    await act(async () => {
      state.href = window.location.href;
      state.listeners.forEach((listener) => listener());
    });
    expect(state.submit).toHaveBeenCalledExactlyOnceWith("synthetic-routed");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/",
      replace: true,
      hash: addComputerHash(otherLink),
    });
  });
});

describe("same-page add-computer links", () => {
  async function renderPrompt() {
    await act(async () =>
      root.render(
        <StrictMode>
          <AddComputerLinkPrompt />
        </StrictMode>,
      ),
    );
  }

  it("asks for confirmation for a link opened after mount, strips only that link, and adds once", async () => {
    await renderPrompt();
    await incoming(`${addComputerHash(otherLink)}&keep=value`);
    expect(new URL(window.location.href).hash).toBe("#keep=value");
    await incoming(addComputerHash(otherLink));
    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.connect).toHaveBeenCalledExactlyOnceWith({ pairingUrl: otherLink });
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
    expect(readAddComputerLink(new URL(window.location.href))).toBeNull();
  });

  it("does not pair a declined link or ask about the same one again", async () => {
    state.confirm.mockResolvedValue(false);
    await renderPrompt();
    await incoming(addComputerHash(otherLink));
    await incoming(addComputerHash(otherLink));
    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.connect).not.toHaveBeenCalled();
    await incoming(addComputerHash("https://new.example.test/pair#token=synthetic-new"));
    expect(state.confirm).toHaveBeenCalledTimes(2);
  });

  it("keeps rapid incoming links behind the current confirmation without duplicate prompts", async () => {
    let confirmFirst!: (confirmed: boolean) => void;
    state.confirm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          confirmFirst = resolve;
        }),
    );
    await renderPrompt();
    await incoming(addComputerHash(otherLink));
    await incoming(addComputerHash(otherLink));
    const nextLink = "https://next.example.test/pair#token=synthetic-next-computer";
    await incoming(addComputerHash(nextLink));
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.connect).not.toHaveBeenCalled();
    await act(async () => confirmFirst(true));
    expect(state.confirm).toHaveBeenCalledTimes(2);
    expect(state.connect.mock.calls.map(([input]) => input)).toEqual([
      { pairingUrl: otherLink },
      { pairingUrl: nextLink },
    ]);
  });
});
