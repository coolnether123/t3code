/** @vitest-environment happy-dom */
import type { BirthdayCelebrationPreference } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BirthdaySettings } from "./BirthdaySettings";

const state = vi.hoisted(() => ({
  saved: null as BirthdayCelebrationPreference | null,
  update: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (
    select: (settings: { birthdayCelebration: BirthdayCelebrationPreference | null }) => unknown,
  ) => select({ birthdayCelebration: state.saved }),
  useUpdatePrimarySettings: () => state.update,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "test" }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    children,
    title,
    id,
  }: {
    children: ReactNode;
    title: string;
    id: string;
  }) => (
    <section id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("birthday settings", () => {
  it("saves an editable private date and removes it without a code default", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.saved = { month: 5, day: 14, enabled: true, tapEffects: true };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<BirthdaySettings />));
      const month = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Birthday month"]',
      )!;
      expect(month.value).toBe("5");
      await act(async () => {
        month.value = "6";
        month.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const effects = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
      await act(async () => effects.click());
      await act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(state.update).toHaveBeenLastCalledWith({
        birthdayCelebration: { month: 6, day: 14, enabled: true, tapEffects: false },
      });
      const remove = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove birthday",
      )!;
      await act(async () => remove.click());
      expect(state.update).toHaveBeenLastCalledWith({ birthdayCelebration: null });
      state.saved = null;
      await act(async () => root.render(<BirthdaySettings />));
      expect(month.value).toBe("");
      expect(
        container.querySelector<HTMLInputElement>('input[aria-label="Birthday day"]')!.value,
      ).toBe("");
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("rejects a nonexistent calendar day before updating the server", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.saved = { month: 1, day: 31, enabled: true, tapEffects: true };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<BirthdaySettings />));
      const month = container.querySelector("select")!;
      await act(async () => {
        month.value = "2";
        month.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(state.update).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "valid month and day",
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
});
