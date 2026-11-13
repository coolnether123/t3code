import type { BirthdayCelebrationPreference } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import { BirthdayCelebration, BirthdayGreeting } from "./BirthdayCelebration";

const state = vi.hoisted(() => ({ birthday: null as BirthdayCelebrationPreference | null }));
vi.mock("../hooks/useSettings", () => ({
  usePrimarySettings: (
    select: (settings: { birthdayCelebration: BirthdayCelebrationPreference | null }) => unknown,
  ) => select({ birthdayCelebration: state.birthday }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to, className }: { children: ReactNode; to: string; className: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

describe("birthday celebration", () => {
  function setup() {
    const timers = fakeTimers();
    vi.setSystemTime(new Date(2026, 4, 14, 12));
    state.birthday = { month: 5, day: 14, enabled: true, tapEffects: true };
    const action = vi.fn();
    const motion = Object.assign(new EventTarget(), {
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }) as MediaQueryList;
    const media = vi.spyOn(window, "matchMedia").mockReturnValue(motion);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    return {
      action,
      motion,
      [Symbol.dispose]() {
        media.mockRestore();
        visibility.mockRestore();
        timers[Symbol.dispose]();
      },
    };
  }
  const content = (action: () => void) => (
    <BirthdayCelebration>
      <BirthdayGreeting />
      <button onClick={action}>Refresh</button>
      <button disabled>Disabled</button>
    </BirthdayCelebration>
  );
  it("shows the greeting on the configured local date and returns to normal at midnight", async () => {
    using fixture = setup();
    const { action } = fixture;
    vi.setSystemTime(new Date(2026, 4, 14, 23, 59, 50));
    // The router is mocked for this component.
    await using screen = await render(content(action), { router: false });
    const { container } = screen;
    expect(document.documentElement.hasAttribute("data-birthday")).toBe(true);
    expect(container.textContent).toContain("Happy birthday");
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(document.documentElement.hasAttribute("data-birthday")).toBe(false);
    expect(container.textContent).not.toContain("Happy birthday");
  });
  it.each([
    null,
    { month: 5, day: 15, enabled: true, tapEffects: true },
    { month: 5, day: 14, enabled: false, tapEffects: true },
  ])("does not decorate other dates or an unconfigured/disabled birthday", async (birthday) => {
    using fixture = setup();
    const { action } = fixture;
    state.birthday = birthday;
    // The router is mocked for this component.
    await using screen = await render(content(action), { router: false });
    const { container } = screen;
    expect(document.documentElement.hasAttribute("data-birthday")).toBe(false);
    expect(container.textContent).not.toContain("Happy birthday");
  });
  it("supports a reversible candle wish and a settings link", async () => {
    using fixture = setup();
    const { action } = fixture;
    // The router is mocked for this component.
    await using screen = await render(content(action), { router: false });
    const { container } = screen;
    const wish = container.querySelector<HTMLButtonElement>('[aria-label="Make a birthday wish"]')!;
    await act(async () => wish.click());
    expect(container.textContent).toContain("Wish made");
    expect(wish.getAttribute("aria-label")).toBe("Light the birthday candle again");
    await act(async () => wish.click());
    expect(wish.getAttribute("aria-label")).toBe("Make a birthday wish");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/settings/appearance");
  });
  it("keeps discovered notes across usage-page changes and lets the user fold them away", async () => {
    using fixture = setup();
    const { action } = fixture;
    // The router is mocked for this component.
    await using screen = await render(content(action), { router: false });
    const { container } = screen;
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".birthday-note-toggle")!.click(),
    );
    const first = container.querySelector(".birthday-note p")!.textContent;
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".birthday-note button")!.click(),
    );
    const next = container.querySelector(".birthday-note p")!.textContent;
    expect(next).not.toBe(first);
    await screen.rerender(
      <BirthdayCelebration>
        <BirthdayGreeting key="other-usage-page" />
      </BirthdayCelebration>,
    );
    expect(container.querySelector(".birthday-note")).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".birthday-note-toggle")!.click(),
    );
    expect(container.querySelector(".birthday-note p")!.textContent).toBe(next);
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".birthday-note-toggle")!.click(),
    );
    expect(container.querySelector(".birthday-note")).toBeNull();
  });
  it("varies the cake and starting note each year without storing an age", async () => {
    using fixture = setup();
    const { action } = fixture;
    // The router is mocked for this component.
    await using screen = await render(content(action), { router: false });
    const { container } = screen;
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".birthday-note-toggle")!.click(),
    );
    const cake = container.querySelector("svg title")!.textContent;
    const note = container.querySelector(".birthday-note p")!.textContent;
    vi.setSystemTime(new Date(2027, 4, 14, 12));
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(container.querySelector("svg title")!.textContent).not.toBe(cake);
    expect(container.querySelector(".birthday-note p")!.textContent).not.toBe(note);
  });
  it("replaces built-in notes with private plain text and updates when the saved notes change", async () => {
    using fixture = setup();
    const { action } = fixture;
    state.birthday = {
      ...state.birthday!,
      notes: ["A birthday for the example project.", "<b>More cake</b>"],
    };
    // The router is mocked for this component.
    await using screen = await render(content(action), { router: false });
    const { container } = screen;
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".birthday-note-toggle")!.click(),
    );
    expect(container.querySelector(".birthday-note p")!.textContent).toBe(
      "A birthday for the example project.",
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".birthday-note button")!.click(),
    );
    expect(container.querySelector(".birthday-note p")!.textContent).toBe("<b>More cake</b>");
    expect(container.querySelector(".birthday-note b")).toBeNull();
    state.birthday = { ...state.birthday!, notes: ["A newly saved wish."] };
    await screen.rerender(content(action));
    expect(container.querySelector(".birthday-note p")!.textContent).toBe("A newly saved wish.");
    state.birthday = { ...state.birthday!, notes: [] };
    await screen.rerender(content(action));
    expect(container.querySelector(".birthday-note p")!.textContent).toBeTruthy();
    expect(container.querySelector(".birthday-note p")!.textContent).not.toBe(
      "A newly saved wish.",
    );
  });
  it("adds bounded short bursts without replacing the button action", async () => {
    using fixture = setup();
    const { action } = fixture;
    // The router is mocked for this component.
    await using screen = await render(content(action), { router: false });
    const { container } = screen;
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Refresh",
    )!;
    for (let index = 0; index < 5; index++) {
      await act(async () => {
        vi.advanceTimersByTime(110);
        button.click();
      });
    }
    expect(action).toHaveBeenCalledTimes(5);
    expect(container.querySelectorAll(".birthday-burst")).toHaveLength(3);
    expect(container.querySelectorAll(".birthday-burst i")).toHaveLength(36);
    await act(async () => vi.advanceTimersByTime(900));
    expect(container.querySelectorAll(".birthday-burst")).toHaveLength(0);
  });
  it("keeps the palette and candle without motion when effects are off or reduced", async () => {
    using fixture = setup();
    const { action } = fixture;
    state.birthday = { ...state.birthday!, tapEffects: false };
    // The router is mocked for this component.
    await using screen = await render(content(action), { router: false });
    const { container } = screen;
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.documentElement.hasAttribute("data-birthday")).toBe(true);
    expect(container.querySelectorAll(".birthday-burst")).toHaveLength(0);
    state.birthday = { ...state.birthday, tapEffects: true };
    Object.assign(fixture.motion, { matches: true });
    await screen.rerender(content(action));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelectorAll(".birthday-burst")).toHaveLength(0);
  });
  it("clears in-flight effects when the user disables motion", async () => {
    using fixture = setup();
    const { action } = fixture;
    // The router is mocked for this component.
    await using screen = await render(content(action), { router: false });
    const { container } = screen;
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.querySelectorAll(".birthday-burst")).toHaveLength(1);
    await act(async () => {
      Object.assign(fixture.motion, { matches: true });
      fixture.motion.dispatchEvent(new Event("change"));
    });
    expect(container.querySelectorAll(".birthday-burst")).toHaveLength(0);
  });
});
