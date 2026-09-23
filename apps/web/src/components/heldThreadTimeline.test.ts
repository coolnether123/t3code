import { afterEach, expect, it } from "vite-plus/test";

import {
  isPaintOnlyThreadTimeline,
  rememberReadyThreadTimeline,
  resetHeldThreadTimeline,
  resolveThreadSwitchTimeline,
} from "./heldThreadTimeline";

afterEach(resetHeldThreadTimeline);

it("paints the destination's remembered messages on its first loading frame", () => {
  const first = [{ text: "first" }];
  const second = [{ text: "second" }];
  rememberReadyThreadTimeline({ threadKey: "env:first", entries: first });
  rememberReadyThreadTimeline({ threadKey: "env:second", entries: second });
  const result = resolveThreadSwitchTimeline({
    loading: true,
    activeThreadKey: "env:first",
    nextEntries: [],
  });
  expect(result).toEqual({ entries: first, displayThreadKey: "env:first" });
  expect(isPaintOnlyThreadTimeline(result.displayThreadKey, "env:first")).toBe(false);
});

it("holds the preceding thread only while the destination loads in the same environment", () => {
  const previous = [{ text: "previous" }];
  rememberReadyThreadTimeline({ threadKey: "env:one", entries: previous });
  const loading = resolveThreadSwitchTimeline({
    loading: true,
    activeThreadKey: "env:two",
    nextEntries: [],
  });
  expect(loading.entries).toBe(previous);
  expect(isPaintOnlyThreadTimeline(loading.displayThreadKey, "env:two")).toBe(true);
  expect(
    resolveThreadSwitchTimeline({
      loading: false,
      activeThreadKey: "env:two",
      nextEntries: [],
    }).entries,
  ).toEqual([]);
  expect(
    resolveThreadSwitchTimeline({
      loading: true,
      activeThreadKey: "other:two",
      nextEntries: [],
    }).entries,
  ).toEqual([]);
});

it("bounds retained chats and never paints another thread once new entries arrive", () => {
  const first = [{ text: "old" }];
  rememberReadyThreadTimeline({ threadKey: "env:one", entries: first });
  for (const key of ["two", "three", "four", "five"]) {
    rememberReadyThreadTimeline({ threadKey: `env:${key}`, entries: [{ text: key }] });
  }
  expect(
    resolveThreadSwitchTimeline({ loading: true, activeThreadKey: "env:one", nextEntries: [] })
      .displayThreadKey,
  ).toBe("env:five");
  const fresh = [{ text: "fresh" }];
  expect(
    resolveThreadSwitchTimeline({ loading: true, activeThreadKey: "env:one", nextEntries: fresh }),
  ).toEqual({ entries: fresh, displayThreadKey: "env:one" });
});
