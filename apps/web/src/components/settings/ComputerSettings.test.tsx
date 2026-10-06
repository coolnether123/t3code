/** @vitest-environment happy-dom */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ComputerSettings } from "./ComputerSettings";

const state = vi.hoisted(() => ({
  writes: vi.fn(),
  connected: true,
  supported: true,
  phase: "connected",
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: ["Example A", "Example B"].map((label, index) => ({
      environmentId: `computer-${index}`,
      label,
      color: index === 0 ? "#123abc" : "#654321",
      connection: { phase: state.connected ? state.phase : "disconnected" },
      serverConfig: state.connected
        ? { environment: { label, capabilities: { computerAppearance: state.supported } } }
        : null,
    })),
  }),
  useEnvironment: (id: string) => ({
    label: id === "computer-0" ? "Example A" : "Example B",
    color: "#123abc",
  }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    environmentName: "",
    environmentColor: null,
    developerToolsEnabled: false,
  }),
  useUpdateEnvironmentSettings: (id: string) => (patch: unknown) => state.writes(id, patch),
}));
vi.mock("./EnvironmentIconPicker", () => ({
  useEnvironmentOperateAccess: () => "granted",
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({ title, control }: { title: string; control: ReactNode }) => (
    <div>
      {title}
      {control}
    </div>
  ),
  SettingResetButton: () => null,
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  state.writes.mockClear();
  state.connected = true;
  state.supported = true;
  state.phase = "connected";
  vi.unstubAllGlobals();
});

async function renderSettings() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<ComputerSettings />));
}

describe("computer settings", () => {
  it("saves the name and color to the selected computer and offers one developer toggle", async () => {
    await renderSettings();
    const name = document.querySelector<HTMLInputElement>(
      '[aria-label="Computer name for Example B"]',
    )!;
    const color = document.querySelector<HTMLInputElement>(
      '[aria-label="Computer color for Example B"]',
    )!;
    await act(async () => name.focus());
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(name, "  Millie  ");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => name.blur());
    await act(async () => color.focus());
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(color, "#abcdef");
      color.dispatchEvent(new Event("input", { bubbles: true }));
      color.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => color.blur());
    const toggle = document.querySelector<HTMLButtonElement>(
      '[aria-label="Show developer tools for Example B"]',
    )!;
    await act(async () => toggle.click());
    expect(state.writes.mock.calls).toEqual([
      ["computer-1", { environmentName: "Millie" }],
      ["computer-1", { environmentColor: "#abcdef" }],
      ["computer-1", { developerToolsEnabled: true }],
    ]);
    expect(document.querySelectorAll('input[type="color"]')).toHaveLength(2);
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(2);
  });

  it("lets the computer serving this page edit itself even though it is not a saved remote", async () => {
    state.phase = "available";
    await renderSettings();
    const name = document.querySelector<HTMLInputElement>(
      '[aria-label="Computer name for Example A"]',
    )!;
    expect(name.disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Connect to this computer");
  });

  it.each(["disconnected", "older server"])(
    "does not offer unsavable controls for a %s",
    async (mode) => {
      state.connected = mode !== "disconnected";
      state.supported = mode !== "older server";
      await renderSettings();
      for (const input of document.querySelectorAll<HTMLInputElement>("input"))
        expect(input.disabled).toBe(true);
      expect(state.writes).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        mode === "disconnected" ? "Connect to this computer" : "Update this computer",
      );
    },
  );
});
