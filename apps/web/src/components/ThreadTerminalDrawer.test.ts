import { describe, expect, it, vi } from "vite-plus/test";

import {
  TERMINAL_ACCESSORY_KEYS,
  closeTerminalAfterConfirmation,
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalExit,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
  terminalSelectionLineRange,
} from "./ThreadTerminalDrawer";

describe("TERMINAL_ACCESSORY_KEYS", () => {
  it("sends terminal control sequences for phone-only keys", () => {
    expect(Object.fromEntries(TERMINAL_ACCESSORY_KEYS.map((key) => [key.label, key.data]))).toEqual(
      {
        Esc: "\u001b",
        Tab: "\t",
        "↑": "\u001b[A",
        "↓": "\u001b[B",
        "←": "\u001b[D",
        "→": "\u001b[C",
        "Ctrl-C": "\u0003",
        "Ctrl-D": "\u0004",
      },
    );
  });
});

describe("closeTerminalAfterConfirmation", () => {
  it("waits for an affirmative user confirmation before closing", async () => {
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const onClose = vi.fn();
    const closing = closeTerminalAfterConfirmation({
      terminalId: "terminal-1",
      terminalLabel: "Development server",
      confirm,
      onClose,
    });

    expect(confirm).toHaveBeenCalledWith(["Development server"]);
    expect(onClose).not.toHaveBeenCalled();
    resolveConfirmation?.(true);
    await closing;
    expect(onClose).toHaveBeenCalledWith("terminal-1");
  });

  it("leaves the terminal running when confirmation is declined", async () => {
    const onClose = vi.fn();
    await closeTerminalAfterConfirmation({
      terminalId: "terminal-1",
      terminalLabel: "Development server",
      confirm: async () => false,
      onClose,
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });

  it("uses Ghostty's physical screen range for visually wrapped selections", () => {
    expect(
      terminalSelectionLineRange({
        start: { y: 4 },
        end: { y: 6 },
      }),
    ).toEqual({ lineStart: 5, lineEnd: 7 });
  });

  it("handles an exit that lands while the terminal surface is still loading", () => {
    expect(shouldHandleTerminalExit("exited", "running", false)).toBe(true);
    expect(shouldHandleTerminalExit("exited", "exited", false)).toBe(false);
    expect(shouldHandleTerminalExit("closed", "running", true)).toBe(false);
  });
});
