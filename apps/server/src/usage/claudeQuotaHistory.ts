/**
 * Saved Claude subscription readings.
 *
 * Claude reports its session, weekly, and model-scoped weekly windows as
 * percentages through the CLI's usage request. Each reading is kept per window
 * in a small JSON document in the server state directory so the reset monitor
 * can chart Claude cycles with the same math it uses for Codex's weekly cycle.
 * Identical consecutive readings are coalesced, but one is kept at least
 * hourly so a quiet stretch still draws its flat segment.
 *
 * @module claudeQuotaHistory
 */
import * as DateTime from "effect/DateTime";

import type {
  ServerProviderUsageWindow,
  UsageProviderQuotaHistory,
  UsageQuotaSample,
} from "@t3tools/contracts";

export const CLAUDE_QUOTA_HISTORY_FILE = "usage-claude-quota-history.json";
const RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
const MAX_SAMPLES_PER_WINDOW = 12_000;
const KEEP_UNCHANGED_EVERY_MS = 60 * 60 * 1000;

type SavedSample = readonly [observedAtMs: number, remainingPercent: number, resetsAtMs: number];

interface SavedWindow {
  readonly label: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly windowDurationMins?: number;
  readonly samples: readonly SavedSample[];
}

export interface ClaudeQuotaHistoryDocument {
  readonly version: 1;
  readonly windows: Readonly<Record<string, SavedWindow>>;
  /** Last attempt, successful or not. */
  readonly checkedAtMs?: number;
  /** Why the last attempt produced no reading; cleared by the next reading. */
  readonly unavailable?: string;
}

export const emptyClaudeQuotaHistory: ClaudeQuotaHistoryDocument = { version: 1, windows: {} };

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Anything malformed reads as empty: saved history must never break a usage read. */
export function decodeClaudeQuotaHistory(document: unknown): ClaudeQuotaHistoryDocument {
  if (typeof document !== "object" || document === null) return emptyClaudeQuotaHistory;
  const root = document as Partial<Record<keyof ClaudeQuotaHistoryDocument, unknown>>;
  if (root.version !== 1 || typeof root.windows !== "object" || root.windows === null) {
    return emptyClaudeQuotaHistory;
  }
  const windows: Record<string, SavedWindow> = {};
  for (const [id, raw] of Object.entries(root.windows)) {
    if (typeof raw !== "object" || raw === null) continue;
    const window = raw as Partial<Record<keyof SavedWindow, unknown>>;
    if (
      typeof window.label !== "string" ||
      (window.kind !== "session" &&
        window.kind !== "weekly" &&
        window.kind !== "monthly" &&
        window.kind !== "other") ||
      !Array.isArray(window.samples)
    ) {
      continue;
    }
    const samples = window.samples.filter(
      (sample): sample is SavedSample =>
        Array.isArray(sample) &&
        sample.length === 3 &&
        isFiniteNumber(sample[0]) &&
        isFiniteNumber(sample[1]) &&
        sample[1] >= 0 &&
        sample[1] <= 100 &&
        isFiniteNumber(sample[2]) &&
        sample[2] >= sample[0],
    );
    windows[id] = {
      label: window.label,
      kind: window.kind,
      ...(isFiniteNumber(window.windowDurationMins)
        ? { windowDurationMins: window.windowDurationMins }
        : {}),
      samples,
    };
  }
  return {
    version: 1,
    windows,
    ...(isFiniteNumber(root.checkedAtMs) ? { checkedAtMs: root.checkedAtMs } : {}),
    ...(typeof root.unavailable === "string" ? { unavailable: root.unavailable } : {}),
  };
}

/**
 * Appends one reading of every reported window. A window without a reset time
 * cannot be placed in a cycle, so it is not recorded.
 */
export function appendClaudeQuotaReadings(
  prior: ClaudeQuotaHistoryDocument,
  readings: readonly ServerProviderUsageWindow[],
  observedAtMs: number,
): ClaudeQuotaHistoryDocument {
  const windows: Record<string, SavedWindow> = { ...prior.windows };
  for (const reading of readings) {
    const resetsAtMs = reading.resetsAt === undefined ? NaN : Date.parse(reading.resetsAt);
    if (!Number.isFinite(resetsAtMs) || resetsAtMs < observedAtMs) continue;
    const remainingPercent = Math.round((100 - reading.usedPercent) * 100) / 100;
    const previous = windows[reading.id];
    const retained = (previous?.samples ?? []).filter(
      ([sampleMs]) => sampleMs >= observedAtMs - RETENTION_MS && sampleMs < observedAtMs,
    );
    const last = retained.at(-1);
    const unchanged =
      last !== undefined &&
      last[1] === remainingPercent &&
      last[2] === resetsAtMs &&
      observedAtMs - last[0] < KEEP_UNCHANGED_EVERY_MS;
    // The newest unchanged reading replaces the previous one, so a flat stretch
    // keeps its start and its latest confirmation without a point every poll.
    const beforeLast = retained.at(-2);
    const samples: SavedSample[] = unchanged
      ? beforeLast !== undefined &&
        beforeLast[1] === remainingPercent &&
        beforeLast[2] === resetsAtMs &&
        observedAtMs - beforeLast[0] < KEEP_UNCHANGED_EVERY_MS
        ? [...retained.slice(0, -1), [observedAtMs, remainingPercent, resetsAtMs]]
        : [...retained, [observedAtMs, remainingPercent, resetsAtMs]]
      : [...retained, [observedAtMs, remainingPercent, resetsAtMs]];
    windows[reading.id] = {
      label: reading.label,
      kind: reading.kind,
      ...(reading.windowDurationMins === undefined
        ? {}
        : { windowDurationMins: reading.windowDurationMins }),
      samples: samples.slice(-MAX_SAMPLES_PER_WINDOW),
    };
  }
  return { version: 1, windows, checkedAtMs: observedAtMs };
}

/** Records a failed attempt without discarding saved readings. */
export function markClaudeQuotaUnavailable(
  prior: ClaudeQuotaHistoryDocument,
  reason: string,
  checkedAtMs: number,
): ClaudeQuotaHistoryDocument {
  return { ...prior, checkedAtMs, unavailable: reason };
}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** The summary shape: one history per window, in session-then-weekly order. */
export function claudeQuotaHistories(
  document: ClaudeQuotaHistoryDocument,
): readonly UsageProviderQuotaHistory[] {
  const order = { session: 0, weekly: 1, monthly: 2, other: 3 } as const;
  const entries = Object.entries(document.windows).sort(
    ([leftId, left], [rightId, right]) =>
      order[left.kind] - order[right.kind] || leftId.localeCompare(rightId),
  );
  const checkedAt =
    document.checkedAtMs === undefined ? {} : { checkedAt: iso(document.checkedAtMs) };
  if (entries.length === 0) {
    return [
      {
        provider: "claude",
        windowId: "seven_day",
        label: "Weekly",
        kind: "weekly",
        windowDurationMins: 7 * 24 * 60,
        status: document.unavailable === undefined ? "missing" : "unavailable",
        message: document.unavailable ?? "No Claude limit readings have been saved yet.",
        samples: [],
        ...checkedAt,
      },
    ];
  }
  return entries.map(([windowId, window]) => ({
    provider: "claude" as const,
    windowId,
    label: window.label,
    kind: window.kind,
    ...(window.windowDurationMins === undefined
      ? {}
      : { windowDurationMins: window.windowDurationMins }),
    status: "ready" as const,
    message: document.unavailable ?? null,
    samples: window.samples.map(
      ([observedAtMs, remainingPercent, resetsAtMs]): UsageQuotaSample => ({
        observedAt: iso(observedAtMs),
        remainingPercent,
        resetsAt: iso(resetsAtMs),
      }),
    ),
    ...checkedAt,
  }));
}
