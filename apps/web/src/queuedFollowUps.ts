import { create } from "zustand";

import type { ChatComposerHandle } from "./components/chat/ChatComposer";

export type QueuedFollowUp = {
  readonly id: string;
  readonly context: ReturnType<ChatComposerHandle["getSendContext"]>;
  readonly holdUntilUserAction?: boolean;
};

type QueuedFollowUpStore = {
  readonly byThread: Record<string, ReadonlyArray<QueuedFollowUp>>;
  enqueue: (threadKey: string, entry: QueuedFollowUp) => void;
  remove: (threadKey: string, id: string) => void;
  hold: (threadKey: string, id: string) => void;
  holdThread: (threadKey: string) => void;
  contains: (threadKey: string, id: string) => boolean;
  claim: (threadKey: string, id: string) => boolean;
  release: (threadKey: string, id: string) => void;
};

const EMPTY_QUEUE: ReadonlyArray<QueuedFollowUp> = [];
const sendClaims = new Set<string>();
const claimKey = (threadKey: string, id: string) => `${threadKey}\u0000${id}`;

// A queued draft may contain File objects. Keep it across route remounts and
// reconnects in memory, without serializing private content to local storage.
export const useQueuedFollowUpStore = create<QueuedFollowUpStore>()((set, get) => ({
  byThread: {},
  enqueue: (threadKey, entry) =>
    set((current) => ({
      byThread: {
        ...current.byThread,
        [threadKey]: [...(current.byThread[threadKey] ?? EMPTY_QUEUE), entry],
      },
    })),
  remove: (threadKey, id) => {
    const wasSending = sendClaims.delete(claimKey(threadKey, id));
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
): QueuedFollowUp | null {
  const first = entries[0];
  return phase === "ready" && first && !first.holdUntilUserAction ? first : null;
}
