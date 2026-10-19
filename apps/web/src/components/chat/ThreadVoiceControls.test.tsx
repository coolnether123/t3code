/** @vitest-environment happy-dom */

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, ProviderInstanceId, type CallStatus } from "@t3tools/contracts";
import type { VoiceState } from "../../voice/session";
import type { Thread } from "../../types";
import { ThreadVoiceControls, type ThreadVoiceHandle } from "./ThreadVoiceControls";

const controller = vi.hoisted(() => ({
  change: undefined as
    | ((state: VoiceState, detail?: string, status?: CallStatus) => void)
    | undefined,
  start: vi.fn(),
  finish: vi.fn(),
  stop: vi.fn(),
  resume: vi.fn(),
  observe: vi.fn(),
  detach: vi.fn(),
}));
vi.mock("../../voice/session", () => ({
  ThreadVoiceSession: class {
    constructor(input: { change: typeof controller.change }) {
      controller.change = input.change;
    }
    start = controller.start;
    finish = controller.finish;
    stop = controller.stop;
    resume = controller.resume;
    observe = controller.observe;
    detach = controller.detach;
  },
}));
vi.mock("../../voice/browserSpeech", () => ({
  createBrowserAudio: () => ({}),
  requestSpeech: async () => ({}),
}));
vi.mock("../../voice/callPersistence", () => ({ callPersistence: () => ({}) }));
vi.mock("./CallModelSelectors", () => ({
  CallModelSelectors: () => <div>Voice model and background agent</div>,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ThreadVoiceControls
        ref={createRef<ThreadVoiceHandle>()}
        thread={
          {
            id: ThreadId.make("synthetic-chat"),
            activities: [],
            messages: [],
            latestTurn: null,
          } as unknown as Thread
        }
        environmentId={EnvironmentId.make("synthetic-environment")}
        modelSelection={{
          instanceId: ProviderInstanceId.make("synthetic-provider"),
          model: "synthetic-model",
        }}
        instanceEntries={[]}
        modelOptionsByInstance={new Map()}
        enabled
        running={false}
        connected
      />,
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("call panel action boundary", () => {
  it("portals the panel outside the composer and starts the call from its separate footer", async () => {
    const trigger = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Call Otis",
    )!;
    await act(async () => trigger.click());
    const panel = document.querySelector<HTMLElement>('section[aria-label="Otis call"]')!;
    expect(panel).not.toBeNull();
    expect(container.contains(panel)).toBe(false);
    expect(panel.querySelector('[data-slot="call-panel-scroll"]')?.textContent).toContain(
      "Voice model",
    );
    const start = panel.querySelector<HTMLButtonElement>(
      '[data-slot="call-panel-actions"] button',
    )!;
    expect(start.textContent).toContain("Start call");
    expect(panel.querySelector('[data-slot="call-panel-scroll"]')?.contains(start)).toBe(false);
    await act(async () => start.click());
    expect(controller.start).toHaveBeenCalledTimes(1);
  });
  it.each(["listening", "error"] as const)(
    "keeps %s actions outside the scroll area",
    async (state) => {
      await act(async () =>
        controller.change?.(state, state === "error" ? "Speech remains queued." : undefined),
      );
      const panel = document.querySelector<HTMLElement>('section[aria-label="Otis call"]')!;
      const footer = panel.querySelector<HTMLElement>('[data-slot="call-panel-actions"]')!;
      const action = footer.querySelector<HTMLButtonElement>("button")!;
      expect(action.textContent).toBe(state === "listening" ? "Send speech" : "Retry saved speech");
      expect(panel.querySelector('[data-slot="call-panel-scroll"]')?.contains(footer)).toBe(false);
      await act(async () => action.click());
      expect(state === "listening" ? controller.finish : controller.resume).toHaveBeenCalledTimes(
        1,
      );
      const end = [...footer.querySelectorAll("button")].find(
        (button) => button.textContent === "End call",
      )!;
      await act(async () => end.click());
      expect(controller.stop).toHaveBeenCalledTimes(1);
    },
  );
});
