/** @vitest-environment happy-dom */

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  type CallStatus,
  type SpeechResponse,
} from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import type { VoiceState } from "../../voice/session";
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
  request: vi.fn<() => Promise<SpeechResponse>>(async () => ({})),
  ensureThread: vi.fn(async () => {}),
  onActiveChange: vi.fn(),
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
  requestSpeech: controller.request,
}));
vi.mock("../../voice/callPersistence", () => ({ callPersistence: () => ({}) }));
vi.mock("../../state/entities", () => ({ useThreadProjection: () => null }));
vi.mock("./CallModelSelectors", () => ({
  CallModelSelectors: () => <div>Voice model and background agent</div>,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  const selection = {
    instanceId: ProviderInstanceId.make("synthetic-provider"),
    model: "synthetic-model",
    options: [{ id: "reasoningEffort", value: "medium" }],
  };
  const hidden = {
    ...selection,
    model: "hidden-remembered-model",
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  controller.request.mockResolvedValue({
    models: { voice: hidden, operator: hidden },
    defaultModels: { voice: selection, operator: selection },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ThreadVoiceControls
        ref={createRef<ThreadVoiceHandle>()}
        ensureThread={controller.ensureThread}
        onActiveChange={controller.onActiveChange}
        isDraft
        threadId={ThreadId.make("synthetic-chat")}
        environmentId={EnvironmentId.make("synthetic-environment")}
        modelSelection={{
          instanceId: ProviderInstanceId.make("synthetic-provider"),
          model: "synthetic-model",
        }}
        instanceEntries={deriveProviderInstanceEntries([
          {
            instanceId: ProviderInstanceId.make("synthetic-provider"),
            driver: ProviderDriverKind.make("codex"),
            displayName: "Synthetic",
            enabled: true,
            installed: true,
            version: "synthetic",
            status: "ready",
            availability: "available",
            auth: { status: "authenticated" },
            checkedAt: "2026-10-19T00:00:00.000Z",
            slashCommands: [],
            skills: [],
            models: [
              { slug: "synthetic-model", name: "Synthetic", isCustom: false, capabilities: {} },
            ],
          },
        ])}
        modelOptionsByInstance={
          new Map([
            [
              ProviderInstanceId.make("synthetic-provider"),
              [{ slug: "synthetic-model", name: "Synthetic" }],
            ],
          ])
        }
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
  it("portals the panel and starts with visible saved defaults when remembered models are hidden", async () => {
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
    expect(controller.start).toHaveBeenCalledWith(
      {
        threadId: "synthetic-chat",
        modelSelection: {
          instanceId: "synthetic-provider",
          model: "synthetic-model",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
        operatorSelection: {
          instanceId: "synthetic-provider",
          model: "synthetic-model",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      },
      [],
    );
  });
  it("dismisses the expanded failed-open panel when hang-up reaches idle", async () => {
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () =>
      controller.change?.("error", "Open an existing chat before starting a call."),
    );
    await act(async () => controller.change?.("idle"));
    expect(document.querySelector('section[aria-label="Otis call"]')).toBeNull();
    expect(controller.onActiveChange).toHaveBeenLastCalledWith(false);
    expect(container.textContent).toBe("Call Otis");
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
