import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";

export type HeldThreadTimeline<T extends readonly unknown[]> = {
  threadKey: string;
  entries: T;
  markdownCwd?: string | null;
  workspaceRoot?: string | null;
};

// Keep a few recently painted lists across route remounts. The entries share
// references with the thread projection; retaining more would pin large chats.
const MAX_HELD_TIMELINES = 4;
const heldTimelines = new Map<string, HeldThreadTimeline<readonly unknown[]>>();
let lastReadyThreadKey: string | null = null;

export function rememberReadyThreadTimeline<T extends readonly unknown[]>(
  held: HeldThreadTimeline<T>,
): void {
  if (held.entries.length === 0) return;
  heldTimelines.delete(held.threadKey);
  heldTimelines.set(held.threadKey, held);
  while (heldTimelines.size > MAX_HELD_TIMELINES) {
    heldTimelines.delete(heldTimelines.keys().next().value!);
  }
  lastReadyThreadKey = held.threadKey;
}

export function peekHeldThreadTimeline<
  T extends readonly unknown[],
>(): HeldThreadTimeline<T> | null {
  return (
    (lastReadyThreadKey === null
      ? null
      : (heldTimelines.get(lastReadyThreadKey) as HeldThreadTimeline<T> | undefined)) ?? null
  );
}

export function peekRememberedThreadTimeline<T extends readonly unknown[]>(
  threadKey: string | null,
): T | null {
  return (
    (threadKey === null ? null : (heldTimelines.get(threadKey)?.entries as T | undefined)) ?? null
  );
}

export function resetHeldThreadTimeline(): void {
  heldTimelines.clear();
  lastReadyThreadKey = null;
}

export function isPaintOnlyThreadTimeline(
  displayedThreadKey: string | null,
  activeThreadKey: string | null,
): boolean {
  return (
    displayedThreadKey !== null &&
    activeThreadKey !== null &&
    displayedThreadKey !== activeThreadKey
  );
}

export function resolveThreadSwitchTimeline<T extends readonly unknown[]>(input: {
  loading: boolean;
  activeThreadKey: string | null;
  nextEntries: T;
}): { entries: T; displayThreadKey: string | null } {
  if (input.nextEntries.length > 0 || !input.loading) {
    return { entries: input.nextEntries, displayThreadKey: input.activeThreadKey };
  }
  const remembered = peekRememberedThreadTimeline<T>(input.activeThreadKey);
  if (remembered !== null && remembered.length > 0) {
    return { entries: remembered, displayThreadKey: input.activeThreadKey };
  }
  const last = peekHeldThreadTimeline<T>();
  const previous = last?.threadKey === undefined ? null : parseScopedThreadKey(last.threadKey);
  const active =
    input.activeThreadKey === null ? null : parseScopedThreadKey(input.activeThreadKey);
  if (
    last !== null &&
    previous !== null &&
    active !== null &&
    previous.environmentId === active.environmentId &&
    last.threadKey !== input.activeThreadKey
  ) {
    return { entries: last.entries, displayThreadKey: last.threadKey };
  }
  return { entries: input.nextEntries, displayThreadKey: input.activeThreadKey };
}
