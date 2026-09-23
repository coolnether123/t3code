import { afterEach, expect, it } from "vite-plus/test";

import {
  nextAutoQueuedFollowUp,
  shouldDispatchQueuedFollowUp,
  useQueuedFollowUpStore,
  type QueuedFollowUp,
} from "./queuedFollowUps";

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
