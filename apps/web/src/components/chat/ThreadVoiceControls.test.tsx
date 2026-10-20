/* oxlint-disable t3code/no-dom-test-environment -- The mocked call controller gate must run without launching a browser. */
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
  onPanelOpenChange: vi.fn(),
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
        onPanelOpenChange={controller.onPanelOpenChange}
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
            driver: ProviderDriverKind.make("claudeAgent"),
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
    "keeps %s controls and errors in the composer with settings closed",
    async (state) => {
      await act(async () =>
        controller.change?.(state, state === "error" ? "Speech remains queued." : undefined),
      );
      const panel = document.querySelector<HTMLElement>('section[aria-label="Otis call"]')!;
      expect(container.contains(panel)).toBe(true);
      expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
      const action = panel.querySelector<HTMLButtonElement>(
        `[aria-label="${state === "listening" ? "Send speech" : "Retry"}"]`,
      )!;
      if (state === "error")
        expect(panel.querySelector('[role="alert"]')?.textContent).toBe("Speech remains queued.");
      await act(async () => action.click());
      expect(state === "listening" ? controller.finish : controller.resume).toHaveBeenCalledTimes(
        1,
      );
      const end = [...panel.querySelectorAll("button")].find(
        (button) => button.textContent === "End call",
      )!;
      await act(async () => end.click());
      expect(controller.stop).toHaveBeenCalledTimes(1);
    },
  );
  it("closes setup on call start and lets settings close without detaching the session", async () => {
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => controller.change?.("preparing", "Checking microphone"));
    expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
    await act(async () => controller.change?.("listening"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Call settings"]')!.click(),
    );
    expect(
      document.querySelector('section[aria-label="Otis call settings"]')?.textContent,
    ).toContain("Voice model");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Close call settings"]')!.click(),
    );
    expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
    expect(controller.onPanelOpenChange).toHaveBeenLastCalledWith(true);
    expect(controller.detach).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Listening");
  });
  it("shows unheard updates behind an expandable count in the call bar", async () => {
    await act(async () =>
      controller.change?.("waiting", undefined, {
        callId: "synthetic",
        threadId: "synthetic-chat",
        version: "1",
        ready: true,
        closed: false,
        modelSelection: {
          instanceId: ProviderInstanceId.make("synthetic-provider"),
          model: "synthetic-model",
        },
        steps: [],
        utterances: [],
        played: [],
        operatorUpdates: [
          {
            id: "update-1",
            jobId: "job",
            status: "done",
            text: "The work is ready.",
            createdAt: "now",
          },
          {
            id: "update-2",
            jobId: "job",
            status: "done",
            text: "Already heard.",
            createdAt: "now",
            heardAt: "now",
          },
        ],
      }),
    );
    const updates = container.querySelector("details")!;
    expect(updates.open).toBe(false);
    expect(updates.querySelector("summary")?.textContent).toBe("Unheard updates (1)");
    expect(updates.textContent).toContain("The work is ready.");
    expect(updates.textContent).not.toContain("Already heard.");
    await act(async () => updates.querySelector("summary")!.click());
    expect(updates.open).toBe(true);
  });
});
