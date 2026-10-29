import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { CodexUsageButton } from "./CodexUsageButton";

async function setup() {
  const onOpen = vi.fn();
  await using stack = new AsyncDisposableStack();
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
  const owned = stack.move();
  return {
    screen,
    onOpen,
    button,
    pointer,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

describe("Codex usage entry", () => {
  it("disables Safari text selection and the native hold menu on the control", async () => {
    await using ui = await setup();
    const markup = renderToStaticMarkup(
      <CodexUsageButton onOpen={ui.onOpen}>
        <span>Codex</span>
      </CodexUsageButton>,
    );
    expect(markup).toContain("-webkit-user-select:none");
    expect(markup).toContain("user-select:none");
    expect(markup).toContain("-webkit-touch-callout:none");
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    ui.button.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(ui.onOpen).not.toHaveBeenCalled();
  });
  it("opens once after holding, without a second navigation on release", async () => {
    await using ui = await setup();
    await act(async () => {
      ui.pointer("pointerdown");
      vi.advanceTimersByTime(549);
    });
    expect(ui.onOpen).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(ui.onOpen).toHaveBeenCalledTimes(1);
    await act(async () => {
      ui.pointer("pointerup");
      ui.button.click();
    });
    expect(ui.onOpen).toHaveBeenCalledTimes(1);
  });
  it("supports an ordinary tap and keyboard activation", async () => {
    await using ui = await setup();
    await act(async () => {
      ui.pointer("pointerdown");
      ui.pointer("pointerup");
      ui.button.click();
      vi.advanceTimersByTime(600);
    });
    expect(ui.onOpen).toHaveBeenCalledTimes(1);
    await act(async () => {
      ui.button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      ui.button.click();
    });
    expect(ui.onOpen).toHaveBeenCalledTimes(2);
  });
  it.each(["move", "cancel", "release"])("does not fire a hold after %s", async (reason) => {
    await using ui = await setup();
    await act(async () => {
      ui.pointer("pointerdown");
      if (reason === "move") ui.pointer("pointermove", { clientY: 40 });
      else ui.pointer(reason === "cancel" ? "pointercancel" : "pointerup");
      vi.advanceTimersByTime(600);
      if (reason !== "release") ui.button.click();
    });
    expect(ui.onOpen).not.toHaveBeenCalled();
  });
  it("cleans up an outstanding hold when the row disappears", async () => {
    await using ui = await setup();
    await act(async () => {
      ui.pointer("pointerdown");
      await ui.screen.rerender(null);
    });
    await act(async () => vi.advanceTimersByTime(600));
    expect(ui.onOpen).not.toHaveBeenCalled();
  });
  it("ignores a secondary finger or right mouse button", async () => {
    await using ui = await setup();
    await act(async () => {
      ui.pointer("pointerdown", { isPrimary: false });
      vi.advanceTimersByTime(600);
      ui.pointer("pointerdown", { pointerType: "mouse", button: 2 });
      vi.advanceTimersByTime(600);
    });
    expect(ui.onOpen).not.toHaveBeenCalled();
  });
});
