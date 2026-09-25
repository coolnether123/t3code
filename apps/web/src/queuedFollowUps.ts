import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import type { ChatComposerHandle } from "./components/chat/ChatComposer";

export type QueuedFollowUp = {
  readonly id: string;
  readonly context: ReturnType<ChatComposerHandle["getSendContext"]>;
  readonly holdUntilUserAction?: boolean;
};

type SteerRestoreBase = {
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly messageId: string;
  readonly text: string;
  readonly targetTurnId: string;
};

export type SteerRestoreRecord = SteerRestoreBase & {
  readonly origin: "composer" | "queue";
  readonly queuedFollowUp: QueuedFollowUp;
};

export type PendingSteerRestore = SteerRestoreRecord & {
  readonly accepted: boolean;
  readonly failureObserved: boolean;
};

export function transitionSteerRestore(
  pending: PendingSteerRestore,
  signal: "accepted" | "failed",
): { readonly pending: PendingSteerRestore | null; readonly restore: SteerRestoreRecord | null } {
  if (signal === "accepted") {
    return pending.failureObserved
      ? { pending: null, restore: pending }
      : { pending: { ...pending, accepted: true }, restore: null };
  }

  return pending.accepted
    ? { pending: null, restore: pending }
    : { pending: { ...pending, failureObserved: true }, restore: null };
}

export function resolveSteerRestoreDestination(
  origin: SteerRestoreRecord["origin"],
  composerHasContent: boolean,
): "composer" | "queue" {
  return origin === "queue" || composerHasContent ? "queue" : "composer";
}

export function prependQueuedFollowUp(
  entries: ReadonlyArray<QueuedFollowUp>,
  entry: QueuedFollowUp,
): ReadonlyArray<QueuedFollowUp> {
  return entries.some((current) => current.id === entry.id) ? entries : [entry, ...entries];
}

export function createSteerFallbackFollowUp(
  id: string,
  text: string,
  context: QueuedFollowUp["context"],
): QueuedFollowUp {
  return {
    id,
    context: {
      ...context,
      prompt: text,
      images: [],
      terminalContexts: [],
      elementContexts: [],
      previewAnnotations: [],
      reviewComments: [],
    },
  };
}

export function failedSteerMessageId(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): string | null {
  if (activity.kind !== "provider.turn.steer.failed" || !activity.payload) return null;
  if (typeof activity.payload !== "object" || Array.isArray(activity.payload)) return null;
  const requestId = (activity.payload as { readonly requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

export function canSteerQueuedFollowUp(entry: QueuedFollowUp): boolean {
  const { prompt, images, terminalContexts, elementContexts, previewAnnotations, reviewComments } =
    entry.context;
  return (
    prompt.trim().length > 0 &&
    images.length === 0 &&
    terminalContexts.length === 0 &&
    elementContexts.length === 0 &&
    previewAnnotations.length === 0 &&
    reviewComments.length === 0
  );
}

type QueuedFollowUpStore = {
  readonly byThread: Record<string, ReadonlyArray<QueuedFollowUp>>;
  readonly steerRestoresByThread: Record<string, Readonly<Record<string, PendingSteerRestore>>>;
  enqueue: (threadKey: string, entry: QueuedFollowUp) => void;
  restoreAtHead: (threadKey: string, entry: QueuedFollowUp) => void;
  remove: (threadKey: string, id: string) => void;
  hold: (threadKey: string, id: string) => void;
  holdThread: (threadKey: string) => void;
  contains: (threadKey: string, id: string) => boolean;
  claim: (threadKey: string, id: string) => boolean;
  release: (threadKey: string, id: string) => void;
  registerSteerRestore: (record: SteerRestoreRecord) => void;
  acceptSteerRestore: (threadKey: string, messageId: string) => SteerRestoreRecord | null;
  observeSteerFailure: (threadKey: string, messageId: string) => SteerRestoreRecord | null;
  cancelSteerRestore: (threadKey: string, messageId: string) => void;
  getSteerRestores: (threadKey: string) => ReadonlyArray<PendingSteerRestore>;
  clearSteerRestoresForTurn: (threadKey: string, turnId: string) => void;
};

const EMPTY_QUEUE: ReadonlyArray<QueuedFollowUp> = [];
const sendClaims = new Set<string>();
const claimKey = (threadKey: string, id: string) => `${threadKey}\u0000${id}`;

// A queued draft may contain File objects. Keep it across route remounts and
// reconnects in memory, without serializing private content to local storage.
export const useQueuedFollowUpStore = create<QueuedFollowUpStore>()((set, get) => ({
  byThread: {},
  steerRestoresByThread: {},
  enqueue: (threadKey, entry) =>
    set((current) => ({
      byThread: {
        ...current.byThread,
        [threadKey]: [...(current.byThread[threadKey] ?? EMPTY_QUEUE), entry],
      },
    })),
  restoreAtHead: (threadKey, entry) =>
    set((current) => {
      const entries = current.byThread[threadKey] ?? EMPTY_QUEUE;
      if (entries.some((queued) => queued.id === entry.id)) return current;
      return {
        byThread: { ...current.byThread, [threadKey]: prependQueuedFollowUp(entries, entry) },
      };
    }),
  remove: (threadKey, id) => {
    const wasSending = sendClaims.has(claimKey(threadKey, id));
    const removed = get().byThread[threadKey]?.find((entry) => entry.id === id);
    if (!wasSending && removed && typeof URL !== "undefined") {
      for (const image of removed.context.images) {
        if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
      }
    }
    set((current) => {
      const next = { ...current.byThread };
      const remaining = (next[threadKey] ?? EMPTY_QUEUE).filter((entry) => entry.id !== id);
      if (remaining.length > 0) next[threadKey] = remaining;
      else delete next[threadKey];
      return { byThread: next };
    });
  },
  hold: (threadKey, id) =>
    set((current) => ({
      byThread: {
        ...current.byThread,
        [threadKey]: (current.byThread[threadKey] ?? EMPTY_QUEUE).map((entry) =>
          entry.id === id ? { ...entry, holdUntilUserAction: true } : entry,
        ),
      },
    })),
  holdThread: (threadKey) =>
    set((current) => ({
      byThread: {
        ...current.byThread,
        [threadKey]: (current.byThread[threadKey] ?? EMPTY_QUEUE).map((entry) => ({
          ...entry,
          holdUntilUserAction: true,
        })),
      },
    })),
  contains: (threadKey, id) => get().byThread[threadKey]?.some((entry) => entry.id === id) ?? false,
  claim: (threadKey, id) => {
    const key = claimKey(threadKey, id);
    if (sendClaims.has(key) || !get().byThread[threadKey]?.some((entry) => entry.id === id))
      return false;
    sendClaims.add(key);
    return true;
  },
  release: (threadKey, id) => {
    sendClaims.delete(claimKey(threadKey, id));
  },
  registerSteerRestore: (record) =>
    set((current) => ({
      steerRestoresByThread: {
        ...current.steerRestoresByThread,
        [record.threadKey]: {
          ...current.steerRestoresByThread[record.threadKey],
          [record.messageId]: { ...record, accepted: false, failureObserved: false },
        },
      },
    })),
  acceptSteerRestore: (threadKey, messageId) => {
    let restore: SteerRestoreRecord | null = null;
    set((current) => {
      const currentByThread = current.steerRestoresByThread[threadKey];
      const pending = currentByThread?.[messageId];
      if (!pending) return current;
      const transition = transitionSteerRestore(pending, "accepted");
      restore = transition.restore;
      const nextByThread = { ...current.steerRestoresByThread };
      const remaining = { ...currentByThread };
      if (transition.pending) remaining[messageId] = transition.pending;
      else delete remaining[messageId];
      if (Object.keys(remaining).length > 0) nextByThread[threadKey] = remaining;
      else delete nextByThread[threadKey];
      return { steerRestoresByThread: nextByThread };
    });
    return restore;
  },
  observeSteerFailure: (threadKey, messageId) => {
    let restore: SteerRestoreRecord | null = null;
    set((current) => {
      const currentByThread = current.steerRestoresByThread[threadKey];
      const pending = currentByThread?.[messageId];
      if (!pending) return current;
      const transition = transitionSteerRestore(pending, "failed");
      restore = transition.restore;
      const nextByThread = { ...current.steerRestoresByThread };
      const remaining = { ...currentByThread };
      if (transition.pending) remaining[messageId] = transition.pending;
      else delete remaining[messageId];
      if (Object.keys(remaining).length > 0) nextByThread[threadKey] = remaining;
      else delete nextByThread[threadKey];
      return { steerRestoresByThread: nextByThread };
    });
    return restore;
  },
  cancelSteerRestore: (threadKey, messageId) =>
    set((current) => {
      const currentByThread = current.steerRestoresByThread[threadKey];
      if (!currentByThread?.[messageId]) return current;
      const nextByThread = { ...current.steerRestoresByThread };
      const remaining = { ...currentByThread };
      delete remaining[messageId];
      if (Object.keys(remaining).length > 0) nextByThread[threadKey] = remaining;
      else delete nextByThread[threadKey];
      return { steerRestoresByThread: nextByThread };
    }),
  getSteerRestores: (threadKey) => Object.values(get().steerRestoresByThread[threadKey] ?? {}),
  clearSteerRestoresForTurn: (threadKey, turnId) =>
    set((current) => {
      const currentByThread = current.steerRestoresByThread[threadKey];
      if (!currentByThread) return current;
      const remaining = Object.fromEntries(
        Object.entries(currentByThread).filter(
          ([, record]) => record.targetTurnId !== turnId || !record.accepted,
        ),
      );
      if (Object.keys(remaining).length === Object.keys(currentByThread).length) return current;
      const nextByThread = { ...current.steerRestoresByThread };
      if (Object.keys(remaining).length > 0) nextByThread[threadKey] = remaining;
      else delete nextByThread[threadKey];
      return { steerRestoresByThread: nextByThread };
    }),
}));

export function useQueuedFollowUps(threadKey: string | null): ReadonlyArray<QueuedFollowUp> {
  return useQueuedFollowUpStore((state) =>
    threadKey === null ? EMPTY_QUEUE : (state.byThread[threadKey] ?? EMPTY_QUEUE),
  );
}

/** Only the head may leave the queue; a failed send holds everything behind it. */
export function nextAutoQueuedFollowUp(
  entries: ReadonlyArray<QueuedFollowUp>,
  phase: "connecting" | "running" | "ready" | "disconnected",
  hasPendingRequest = false,
): QueuedFollowUp | null {
  const first = entries[0];
  return phase === "ready" && !hasPendingRequest && first && !first.holdUntilUserAction
    ? first
    : null;
}

export function shouldDispatchQueuedFollowUp(input: {
  readonly isStillQueued: boolean;
  readonly hasPendingRequest: boolean;
}): boolean {
  return input.isStillQueued && !input.hasPendingRequest;
}
