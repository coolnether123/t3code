/** @vitest-environment happy-dom */

import { EnvironmentId, MessageId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import * as Option from "effect/Option";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadSelectionStore } from "../threadSelectionStore";
import type { TaskTranscriptInput } from "../chatTranscript";
import { MultiChatTranscriptLoader, useMultiChatTranscriptCopy } from "./MultiChatTranscriptLoader";

const mocks = vi.hoisted(() => ({
  threads: new Map<string, TaskTranscriptInput & { id: ThreadId }>(),
  states: new Map<string, EnvironmentThreadState>(),
  listeners: new Set<() => void>(),
  toast: vi.fn(),
  older: vi.fn(() => true),
}));

vi.mock("../state/entities", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useThread: (ref: ScopedThreadRef) =>
      useSyncExternalStore(subscribe, () => mocks.threads.get(scopedThreadKey(ref)) ?? null),
  };
});
vi.mock("../state/threads", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentThread: (environmentId: EnvironmentId, threadId: ThreadId) =>
      useSyncExternalStore(subscribe, () =>
        mocks.states.get(scopedThreadKey(scopeThreadRef(environmentId, threadId))),
      ),
  };
});
vi.mock("@t3tools/client-runtime/state/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/threads")>()),
  requestOlderThreadTurns: mocks.older,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (toast: unknown) => toast,
}));

const first = scopeThreadRef(EnvironmentId.make("synthetic-local"), ThreadId.make("same-id"));
const second = scopeThreadRef(EnvironmentId.make("synthetic-remote"), ThreadId.make("same-id"));
const added = scopeThreadRef(EnvironmentId.make("synthetic-local"), ThreadId.make("added"));
let root: Root;
let container: HTMLDivElement;
let selection: ScopedThreadRef[];
let write: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

function CopyHarness() {
  const copy = useMultiChatTranscriptCopy((refs) =>
    useThreadSelectionStore.getState().removeFromSelection(refs.map(scopedThreadKey)),
  );
  return (
    <>
      <button onClick={() => copy.startCopy(selection)}>Copy selected chats</button>
      <output>{copy.request ? "Loading chats" : "Ready"}</output>
      {copy.request?.threadRefs.map((ref) => (
        <MultiChatTranscriptLoader
          key={`${copy.request?.id}:${scopedThreadKey(ref)}`}
          requestId={copy.request!.id}
          threadRef={ref}
          onLoaded={copy.onLoaded}
          onError={copy.onError}
        />
      ))}
    </>
  );
}

async function render() {
  await act(async () => {
    mocks.listeners.forEach((notify) => notify());
    root.render(<CopyHarness />);
  });
}

function subscribe(notify: () => void) {
  mocks.listeners.add(notify);
  return () => {
    mocks.listeners.delete(notify);
  };
}

async function copySelected() {
  await act(async () => container.querySelector("button")!.click());
}

function setState(ref: ScopedThreadRef, overrides: Partial<EnvironmentThreadState> = {}) {
  mocks.states.set(scopedThreadKey(ref), {
    data: Option.none(),
    status: "live",
    error: Option.none(),
    page: Option.none(),
    ...overrides,
  });
}

beforeEach(async () => {
  mocks.threads.clear();
  mocks.states.clear();
  mocks.listeners.clear();
  mocks.toast.mockReset();
  mocks.older.mockClear();
  useThreadSelectionStore.getState().clearSelection();
  selection = [first, second];
  for (const [ref, title] of [
    [first, "First"],
    [second, "Second"],
    [added, "Added"],
  ] as const) {
    mocks.threads.set(scopedThreadKey(ref), {
      id: ref.threadId,
      threadId: ref.threadId,
      title,
      messages: [],
      activities: [],
    });
    setState(ref);
  }
  selection.forEach((ref) => useThreadSelectionStore.getState().toggleThread(scopedThreadKey(ref)));
  write = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: write } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useThreadSelectionStore.getState().clearSelection();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("selected-chat copy interaction", () => {
  it("waits for every chat and copies selection order across environments with identical IDs", async () => {
    setState(first, { status: "synchronizing" });
    await copySelected();
    expect(write).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Loading chats");
    setState(first);
    await render();
    expect(write).toHaveBeenCalledOnce();
    const text = write.mock.calls[0]![0];
    expect(text.indexOf("Title: First")).toBeLessThan(text.indexOf("Title: Second"));
    expect(text).toContain("\n\n\nCHAT 2 OF 2\n\nT3 Code task transcript");
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Chats copied" }));
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
  });

  it("leaves the clipboard and selection intact on chat failure, then retries the whole batch", async () => {
    setState(second, { error: Option.some("Synthetic chat load failed") });
    await copySelected();
    expect(write).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not copy chats",
        description: "Synthetic chat load failed",
      }),
    );
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(2);
    setState(second);
    await copySelected();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0]).toContain("Title: First");
    expect(write.mock.calls[0]![0]).toContain("Title: Second");
  });

  it("keeps chats selected while loading out of the copied batch and selected afterward", async () => {
    setState(first, { status: "synchronizing" });
    await copySelected();
    selection.push(added);
    useThreadSelectionStore.getState().toggleThread(scopedThreadKey(added));
    setState(first);
    await render();
    expect(write.mock.calls[0]![0]).not.toContain("Title: Added");
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
      scopedThreadKey(added),
    ]);
  });

  it("reports clipboard failure without clearing selection and allows retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    write.mockRejectedValueOnce(new Error("Synthetic clipboard denied"));
    await copySelected();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not copy chats" }),
    );
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(2);
    await copySelected();
    expect(write).toHaveBeenCalledTimes(2);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
  });

  it("ignores a superseded clipboard completion while the new selection loads", async () => {
    let finishWrite = () => {};
    write.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );
    await copySelected();
    selection = [added];
    useThreadSelectionStore.getState().clearSelection();
    useThreadSelectionStore.getState().toggleThread(scopedThreadKey(added));
    setState(added, { status: "synchronizing" });
    await copySelected();
    await act(async () => finishWrite());
    expect(mocks.toast).not.toHaveBeenCalled();
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
      scopedThreadKey(added),
    ]);
    setState(added);
    await render();
    expect(write).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("replaces an unfinished load with the new selection on retry", async () => {
    setState(first, { status: "synchronizing" });
    await copySelected();
    selection = [added];
    await copySelected();
    setState(first);
    await render();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0]).toContain("Title: Added");
    expect(write.mock.calls[0]![0]).not.toContain("Title: First");
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("ignores a superseded clipboard failure without reporting a failed retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let failWrite = (_error: Error) => {};
    write.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        failWrite = reject;
      }),
    );
    await copySelected();
    await copySelected();
    await act(async () => failWrite(new Error("Synthetic stale clipboard failure")));
    expect(write).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Chats copied" }));
  });

  it("does nothing for an empty selection", async () => {
    selection = [];
    await copySelected();
    expect(write).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Ready");
  });

  it("loads older pages before copying complete message text", async () => {
    selection = [first];
    setState(first, {
      page: Option.some({ beforeCursor: "older", hasMore: true, loadingOlder: false }),
    });
    await copySelected();
    expect(mocks.older).toHaveBeenCalledWith(first.environmentId, first.threadId);
    expect(write).not.toHaveBeenCalled();
    const thread = mocks.threads.get(scopedThreadKey(first))!;
    mocks.threads.set(scopedThreadKey(first), {
      ...thread,
      messages: [
        {
          id: MessageId.make("synthetic-message"),
          role: "user",
          text: "Complete older message",
          turnId: null,
          streaming: false,
          createdAt: "2026-10-05T00:00:00Z",
          updatedAt: "2026-10-05T00:00:00Z",
        },
      ],
    });
    setState(first);
    await render();
    expect(write.mock.calls[0]![0]).toContain("Complete older message");
  });

  it("does not write a partial batch when a selected chat is deleted", async () => {
    setState(second, { status: "deleted" });
    await copySelected();
    expect(write).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not copy chats" }),
    );
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(2);
  });
});
