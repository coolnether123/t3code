import { afterEach, expect, it } from "vite-plus/test";

import {
  canSteerQueuedFollowUp,
  createSteerFallbackFollowUp,
  failedSteerMessageId,
  nextAutoQueuedFollowUp,
  prependQueuedFollowUp,
  resolveSteerRestoreDestination,
  shouldDispatchQueuedFollowUp,
  transitionSteerRestore,
  useQueuedFollowUpStore,
  type PendingSteerRestore,
  type QueuedFollowUp,
  type SteerRestoreRecord,
} from "./queuedFollowUps";

it("steers only queued text without attachments or extra context", () => {
  const entry = {
    id: "message",
    context: {
      prompt: "  change course  ",
      images: [],
      terminalContexts: [],
      elementContexts: [],
      previewAnnotations: [],
      reviewComments: [],
    },
  } as unknown as QueuedFollowUp;
  expect(canSteerQueuedFollowUp(entry)).toBe(true);
  expect(
    canSteerQueuedFollowUp({
      ...entry,
      context: { ...entry.context, images: [{ id: "image" }] },
    } as QueuedFollowUp),
  ).toBe(false);
  expect(
    canSteerQueuedFollowUp({
      ...entry,
      context: { ...entry.context, terminalContexts: [{ id: "terminal" }] },
    } as QueuedFollowUp),
  ).toBe(false);
  expect(
    canSteerQueuedFollowUp({
      ...entry,
      context: { ...entry.context, prompt: "  " },
    }),
  ).toBe(false);
});

const sample = (id: string) =>
  ({ id, context: { prompt: id, images: [] } }) as unknown as QueuedFollowUp;
afterEach(() => {
  const store = useQueuedFollowUpStore.getState();
  for (const [key, entries] of Object.entries(store.byThread)) {
    for (const entry of entries) {
      store.release(key, entry.id);
      store.remove(key, entry.id);
    }
  }
  for (const [threadKey, records] of Object.entries(store.steerRestoresByThread)) {
    for (const messageId of Object.keys(records)) {
      store.cancelSteerRestore(threadKey, messageId);
    }
  }
});

it("keeps queues separate across thread switches and claims a message only once", () => {
  const store = useQueuedFollowUpStore.getState();
  store.enqueue("env:one", sample("one"));
  store.enqueue("env:two", sample("two"));
  expect(store.claim("env:one", "one")).toBe(true);
  expect(store.claim("env:one", "one")).toBe(false);
  expect(store.claim("env:two", "two")).toBe(true);
  store.release("env:one", "one");
  expect(store.claim("env:one", "one")).toBe(true);
  expect(store.contains("env:one", "one")).toBe(true);
  store.remove("env:one", "one");
  expect(store.contains("env:one", "one")).toBe(false);
  expect(store.claim("env:one", "one")).toBe(false);
  expect(useQueuedFollowUpStore.getState().byThread["env:two"]).toHaveLength(1);
  const secondThread = useQueuedFollowUpStore.getState().byThread["env:two"]!;
  expect(nextAutoQueuedFollowUp(secondThread, "running")).toBeNull();
  expect(nextAutoQueuedFollowUp(secondThread, "ready")?.id).toBe("two");
  store.release("env:one", "one");
});

it("keeps a removed item's claim until its in-flight send releases it", () => {
  const store = useQueuedFollowUpStore.getState();
  store.enqueue("env:one", sample("one"));
  expect(store.claim("env:one", "one")).toBe(true);

  store.remove("env:one", "one");
  expect(store.contains("env:one", "one")).toBe(false);
  store.enqueue("env:one", sample("one"));
  expect(store.claim("env:one", "one")).toBe(false);

  store.release("env:one", "one");
  expect(store.claim("env:one", "one")).toBe(true);
});

it("removes a steered item without changing the remaining follow-up order", () => {
  const store = useQueuedFollowUpStore.getState();
  store.enqueue("env:one", sample("first"));
  store.enqueue("env:one", sample("second"));
  store.enqueue("env:one", sample("third"));
  expect(store.claim("env:one", "second")).toBe(true);
  store.remove("env:one", "second");
  store.release("env:one", "second");

  expect(useQueuedFollowUpStore.getState().byThread["env:one"]?.map((entry) => entry.id)).toEqual([
    "first",
    "third",
  ]);
  expect(
    nextAutoQueuedFollowUp(useQueuedFollowUpStore.getState().byThread["env:one"]!, "ready")?.id,
  ).toBe("first");
});

it("holds queued follow-ups after interruption without losing their content", () => {
  const store = useQueuedFollowUpStore.getState();
  store.enqueue("env:one", sample("one"));
  store.enqueue("env:one", sample("two"));
  store.holdThread("env:one");
  expect(
    useQueuedFollowUpStore
      .getState()
      .byThread["env:one"]?.map((entry) => [entry.context.prompt, entry.holdUntilUserAction]),
  ).toEqual([
    ["one", true],
    ["two", true],
  ]);
  expect(
    nextAutoQueuedFollowUp(useQueuedFollowUpStore.getState().byThread["env:one"]!, "ready"),
  ).toBeNull();
});

it("rechecks pending requests that arrive while a queued send is preparing", async () => {
  const store = useQueuedFollowUpStore.getState();
  const entry = sample("one");
  store.enqueue("env:one", entry);
  expect(store.claim("env:one", "one")).toBe(true);
  let hasPendingRequest = false;
  const canDispatch = () =>
    shouldDispatchQueuedFollowUp({
      isStillQueued: store.contains("env:one", "one"),
      hasPendingRequest,
    });

  expect(canDispatch()).toBe(true);
  await Promise.resolve();
  hasPendingRequest = true;
  expect(canDispatch()).toBe(false);
  store.release("env:one", "one");
});

it("does not auto-select a queued follow-up while a provider request is pending", () => {
  const entry = sample("one");
  expect(nextAutoQueuedFollowUp([entry], "ready", true)).toBeNull();
  expect(nextAutoQueuedFollowUp([entry], "ready")).toBe(entry);
});

const composerSteerRestore = {
  threadKey: "env:thread",
  threadRef: { environmentId: "env", threadId: "thread" },
  messageId: "steer-message",
  text: "Check the target tab.",
  targetTurnId: "turn-1",
  origin: "composer",
  queuedFollowUp: sample("steer-message"),
} as unknown as SteerRestoreRecord;

it("waits for the accepted receipt before restoring an asynchronous steer failure", () => {
  const pending: PendingSteerRestore = {
    ...composerSteerRestore,
    accepted: false,
    failureObserved: false,
  };
  const failed = transitionSteerRestore(pending, "failed");
  expect(failed).toMatchObject({ pending: { failureObserved: true }, restore: null });

  const accepted = transitionSteerRestore(failed.pending!, "accepted");
  expect(accepted.pending).toBeNull();
  expect(accepted.restore).toMatchObject({
    messageId: "steer-message",
    text: "Check the target tab.",
    origin: "composer",
  });
});

it("consumes a matching failed steer once after the accepted receipt", () => {
  const store = useQueuedFollowUpStore.getState();
  store.registerSteerRestore(composerSteerRestore);
  expect(store.acceptSteerRestore("env:thread", "other-message")).toBeNull();
  expect(store.acceptSteerRestore("env:thread", "steer-message")).toBeNull();

  const restored = store.observeSteerFailure("env:thread", "steer-message");
  expect(restored).toMatchObject({ messageId: "steer-message", origin: "composer" });
  expect(store.observeSteerFailure("env:thread", "steer-message")).toBeNull();
});

it("does not restore a steer rejected by the synchronous receipt", () => {
  const store = useQueuedFollowUpStore.getState();
  store.registerSteerRestore(composerSteerRestore);
  store.cancelSteerRestore("env:thread", "steer-message");
  expect(store.observeSteerFailure("env:thread", "steer-message")).toBeNull();
  expect(store.getSteerRestores("env:thread")).toEqual([]);
});

it("restores queued steer text at the head without duplicating the queue item", () => {
  const store = useQueuedFollowUpStore.getState();
  const original = sample("steered");
  const later = sample("later");
  store.enqueue("env:thread", later);
  store.restoreAtHead("env:thread", original);
  store.restoreAtHead("env:thread", original);
  const entries = useQueuedFollowUpStore.getState().byThread["env:thread"]!;
  const restored = prependQueuedFollowUp(entries, original);
  expect(restored.map((entry) => entry.id)).toEqual(["steered", "later"]);
  expect(prependQueuedFollowUp(restored, original)).toBe(restored);
  expect(entries.map((entry) => entry.id)).toEqual(["steered", "later"]);
});

it("builds a text-only fallback while preserving the queued send settings", () => {
  const context = {
    prompt: "old text",
    images: [{ id: "image" }],
    terminalContexts: [{ id: "terminal" }],
    elementContexts: [{ id: "element" }],
    previewAnnotations: [{ id: "annotation" }],
    reviewComments: [{ id: "comment" }],
    selectedProvider: "codex",
  } as unknown as QueuedFollowUp["context"];
  expect(createSteerFallbackFollowUp("steer", "new text", context)).toMatchObject({
    id: "steer",
    context: {
      prompt: "new text",
      images: [],
      terminalContexts: [],
      elementContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      selectedProvider: "codex",
    },
  });
});

it("chooses the composer only when the original draft is empty", () => {
  expect(resolveSteerRestoreDestination("composer", false)).toBe("composer");
  expect(resolveSteerRestoreDestination("composer", true)).toBe("queue");
  expect(resolveSteerRestoreDestination("queue", false)).toBe("queue");
});

it("extracts only correlated steer failure activities", () => {
  expect(
    failedSteerMessageId({
      kind: "provider.turn.steer.failed",
      payload: { requestId: "steer-message" },
    }),
  ).toBe("steer-message");
  expect(
    failedSteerMessageId({
      kind: "provider.turn.start.failed",
      payload: { requestId: "steer-message" },
    }),
  ).toBeNull();
  expect(failedSteerMessageId({ kind: "provider.turn.steer.failed", payload: {} })).toBeNull();
});
