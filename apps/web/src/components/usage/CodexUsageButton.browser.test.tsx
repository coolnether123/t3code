import { act, fakeTimers, render } from "../../../test/render";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { CodexUsageButton } from "./CodexUsageButton";

async function setup() {
  await using stack = new AsyncDisposableStack();
  const onOpen = vi.fn();
  const screen = stack.use(
    await render(<CodexUsageButton onOpen={onOpen}>Codex</CodexUsageButton>),
  );
  stack.use(fakeTimers());
  const button = screen.container.querySelector("button")!;
  const pointer = (type: string, init: PointerEventInit = {}) => {
    button.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        isPrimary: true,
        pointerType: "touch",
        button: 0,
        clientX: 20,
        clientY: 20,
        ...init,
      }),
    );
  };
  return Object.assign(stack.move(), { screen, button, onOpen, pointer });
}

describe("Codex usage entry", () => {
  it("disables Safari text selection and the native hold menu on the control", async () => {
    await using fixture = await setup();
    const { button, onOpen } = fixture;
    const markup = renderToStaticMarkup(
      <CodexUsageButton onOpen={onOpen}>
        <span>Codex</span>
      </CodexUsageButton>,
    );
    expect(markup).toContain("-webkit-user-select:none");
    expect(markup).toContain("user-select:none");
    expect(markup).toContain("-webkit-touch-callout:none");
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    button.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
  });
  it("opens once after holding, without a second navigation on release", async () => {
    await using fixture = await setup();
    const { button, onOpen, pointer } = fixture;
    await act(async () => {
      pointer("pointerdown");
      vi.advanceTimersByTime(549);
    });
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await act(async () => {
      pointer("pointerup");
      button.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("supports an ordinary tap and keyboard activation", async () => {
    await using fixture = await setup();
    const { button, onOpen, pointer } = fixture;
    await act(async () => {
      pointer("pointerdown");
      pointer("pointerup");
      button.click();
      vi.advanceTimersByTime(600);
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      button.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
  it.each(["move", "cancel", "release"])("does not fire a hold after %s", async (reason) => {
    await using fixture = await setup();
    const { button, onOpen, pointer } = fixture;
    await act(async () => {
      pointer("pointerdown");
      if (reason === "move") pointer("pointermove", { clientY: 40 });
      else pointer(reason === "cancel" ? "pointercancel" : "pointerup");
      vi.advanceTimersByTime(600);
      if (reason !== "release") button.click();
    });
    expect(onOpen).not.toHaveBeenCalled();
  });
  it("cleans up an outstanding hold when the row disappears", async () => {
    await using fixture = await setup();
    const { onOpen, pointer, screen } = fixture;
    await act(async () => {
      pointer("pointerdown");
      await screen.unmount();
    });
    await act(async () => vi.advanceTimersByTime(600));
    expect(onOpen).not.toHaveBeenCalled();
  });
  it("ignores a secondary finger or right mouse button", async () => {
    await using fixture = await setup();
    const { onOpen, pointer } = fixture;
    await act(async () => {
      pointer("pointerdown", { isPrimary: false });
      vi.advanceTimersByTime(600);
      pointer("pointerdown", { pointerType: "mouse", button: 2 });
      vi.advanceTimersByTime(600);
    });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
