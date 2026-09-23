import type { UsageQuotaInterval, UsageTokenTotals } from "@t3tools/contracts";
import type { QuotaEnvironment } from "@t3tools/shared/usageQuota";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

const ENDPOINT = "https://codex-resets.com/api/v1/resets?limit=100&order=desc";
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_INTERVALS = 64;

export interface PublicResetAnnouncement {
  readonly id: string;
  readonly resetType: "regular" | "banked";
  readonly announcedAt: string;
  readonly text: string;
  readonly sourceType: "x_post" | "observed";
  readonly sourceUrl: string | null;
}

export interface PublicResetHistory {
  readonly announcements: readonly PublicResetAnnouncement[];
  readonly checkedAt: number | null;
  readonly status: "loading" | "ready" | "unavailable";
}

export interface PublicResetPeriod {
  readonly interval: UsageQuotaInterval;
  readonly startedBy: PublicResetAnnouncement;
  readonly endedBy: PublicResetAnnouncement;
}

export interface PublicResetModelEstimate {
  readonly model: string;
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  readonly records: number;
  readonly unpricedRecords: number;
}

export interface PublicResetCostEstimate extends PublicResetPeriod {
  readonly costUsd: number | null;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly models: readonly PublicResetModelEstimate[];
  readonly reason: string | null;
}

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>),
);
class PublicResetHistoryUnavailable extends Data.TaggedError("PublicResetHistoryUnavailable") {}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const instant = (value: unknown): value is string =>
  typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));

function decodeSource(value: unknown) {
  const source = object(value);
  if (!source) return null;
  if (
    source.type === "x_post" &&
    source.author === "thsottiaux" &&
    typeof source.url === "string" &&
    /^https:\/\/x\.com\/thsottiaux\/status\/\d+$/.test(source.url)
  ) {
    return { sourceType: "x_post" as const, sourceUrl: source.url };
  }
  if (source.type !== "observed") return null;
  if (source.url === undefined) return { sourceType: "observed" as const, sourceUrl: null };
  if (
    typeof source.url !== "string" ||
    !/^https:\/\/x\.com\/thsottiaux\/status\/\d+$/.test(source.url)
  ) {
    return null;
  }
  return { sourceType: "observed" as const, sourceUrl: source.url };
}

/** Decode the documented v1 response without trusting its text or outbound links. */
export function decodePublicResetHistory(
  value: unknown,
  now: number,
): readonly PublicResetAnnouncement[] | null {
  const root = object(value);
  const meta = object(root?.meta);
  if (meta?.api_version !== "v1" || !instant(meta.generated_at) || !Array.isArray(root?.data))
    return null;
  const announcements = new Map<string, PublicResetAnnouncement>();
  for (const candidate of root.data) {
    const item = object(candidate);
    const source = decodeSource(item?.source);
    if (
      !item ||
      typeof item.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) ||
      (item.reset_type !== "regular" && item.reset_type !== "banked") ||
      !instant(item.announced_at) ||
      Date.parse(item.announced_at) > now + 5 * 60_000 ||
      typeof item.text !== "string" ||
      item.text.length > 20_000 ||
      !source
    ) {
      return null;
    }
    const announcement: PublicResetAnnouncement = {
      id: item.id,
      resetType: item.reset_type,
      announcedAt: item.announced_at,
      text: item.text,
      ...source,
    };
    const previous = announcements.get(announcement.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(announcement)) return null;
    announcements.set(announcement.id, announcement);
  }
  return [...announcements.values()].sort((a, b) =>
    a.announcedAt === b.announcedAt
      ? a.id.localeCompare(b.id)
      : a.announcedAt.localeCompare(b.announcedAt),
  );
}

/** Regular announcements bound estimated periods. Banked grants need user redemption first. */
export function publicResetPeriods(
  announcements: readonly PublicResetAnnouncement[],
): readonly PublicResetPeriod[] {
  const regular = announcements
    .filter((announcement) => announcement.resetType === "regular")
    .filter(
      (announcement, index, all) =>
        all.findIndex((candidate) => candidate.announcedAt === announcement.announcedAt) === index,
    )
    .sort((a, b) => a.announcedAt.localeCompare(b.announcedAt))
    .slice(-(MAX_INTERVALS + 1));
  return regular.slice(0, -1).map((startedBy, index) => {
    const endedBy = regular[index + 1]!;
    return {
      interval: {
        id: `codex-resets:${startedBy.id}`,
        sinceTime: startedBy.announcedAt,
        untilTime: endedBy.announcedAt,
      },
      startedBy,
      endedBy,
    };
  });
}

export const publicResetIntervals = (announcements: readonly PublicResetAnnouncement[]) =>
  publicResetPeriods(announcements).map((period) => period.interval);

const emptyTotals = (): UsageTokenTotals => ({
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

const fingerprintKey = (fingerprint: {
  readonly hostId: string;
  readonly provider: string;
  readonly resolvedHomePath: string;
  readonly volumeId: string;
}) =>
  JSON.stringify([
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ]);

/** Aggregate exact transcript rows while keeping partial and unpriced periods visibly unknown. */
export function publicResetCostEstimates(
  announcements: readonly PublicResetAnnouncement[],
  environments: readonly QuotaEnvironment[],
): readonly PublicResetCostEstimate[] {
  return publicResetPeriods(announcements).map((period) => {
    const seen = new Set<string>();
    const models = new Map<string, PublicResetModelEstimate>();
    let costUsd = 0;
    let records = 0;
    let unpricedRecords = 0;
    let complete = environments.length > 0;
    for (const environment of [...environments].sort((a, b) =>
      a.environmentId.localeCompare(b.environmentId),
    )) {
      const summary = environment.summary;
      if (!summary || environment.error) {
        complete = false;
        continue;
      }
      const sources = summary.sources.filter(
        (source) => source.fingerprint.provider === "codex" && source.status !== "missing",
      );
      for (const source of sources) {
        const key = fingerprintKey(source.fingerprint);
        if (seen.has(key)) continue;
        const row = summary.quotaCosts?.find(
          (candidate) =>
            candidate.intervalId === period.interval.id &&
            fingerprintKey(candidate.fingerprint) === key,
        );
        if (!row) {
          complete = false;
          continue;
        }
        seen.add(key);
        if (!row.complete || source.status !== "ok") complete = false;
        costUsd += row.costUsd;
        records += row.records;
        unpricedRecords += row.unpricedRecords;
        for (const model of row.models ?? []) {
          const previous = models.get(model.model);
          const totals = previous?.totals ?? emptyTotals();
          models.set(model.model, {
            model: model.model,
            costUsd: (previous?.costUsd ?? 0) + model.costUsd,
            records: (previous?.records ?? 0) + model.records,
            unpricedRecords: (previous?.unpricedRecords ?? 0) + model.unpricedRecords,
            totals: {
              uncachedInputTokens: totals.uncachedInputTokens + model.totals.uncachedInputTokens,
              cachedInputTokens: totals.cachedInputTokens + model.totals.cachedInputTokens,
              cacheCreationTokens: totals.cacheCreationTokens + model.totals.cacheCreationTokens,
              outputTokens: totals.outputTokens + model.totals.outputTokens,
              reasoningTokens: totals.reasoningTokens + model.totals.reasoningTokens,
            },
          });
        }
      }
    }
    let reason: string | null = null;
    if (environments.length === 0) reason = "No computers are selected.";
    else if (seen.size === 0) reason = "No Codex transcript source is available for this period.";
    else if (!complete)
      reason = "The transcript scan is incomplete, so the period total is withheld.";
    else if (unpricedRecords > 0)
      reason = "Some matching records have no model price, so the period total is withheld.";
    else if (records === 0)
      reason = "No matching transcript usage was found. Missing history is not zero usage.";
    return {
      ...period,
      costUsd: reason === null ? costUsd : null,
      records,
      unpricedRecords,
      models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd),
      reason,
    };
  });
}

/** No account, transcript, credential, referrer, or trace data accompanies this public read. */
export function watchPublicResetHistory(onHistory: (history: PublicResetHistory) => void) {
  const read = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(ENDPOINT);
    if (response.status < 200 || response.status >= 300)
      return yield* new PublicResetHistoryUnavailable();
    const body = yield* response.text;
    if (body.length > MAX_RESPONSE_BYTES) return yield* new PublicResetHistoryUnavailable();
    const document = yield* decodeJson(body);
    const now = yield* Clock.currentTimeMillis;
    const announcements = decodePublicResetHistory(document, now);
    if (!announcements) return yield* new PublicResetHistoryUnavailable();
    return {
      announcements,
      checkedAt: now,
      status: "ready",
    } satisfies PublicResetHistory;
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catch(() =>
      Effect.map(
        Clock.currentTimeMillis,
        (now) =>
          ({
            announcements: [],
            checkedAt: now,
            status: "unavailable",
          }) satisfies PublicResetHistory,
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-cache",
      headers: { Accept: "application/json" },
    }),
  );
  let stopped = false;
  let pending: Promise<boolean> | null = null;
  let requestFiber: Fiber.Fiber<PublicResetHistory> | null = null;
  const refresh = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    if (pending) return pending;
    requestFiber = Effect.runFork(read);
    pending = Effect.runPromise(Fiber.join(requestFiber))
      .then(
        (history) => {
          if (!stopped) onHistory(history);
          return !stopped && history.status === "ready";
        },
        () => {
          if (!stopped)
            onHistory({
              announcements: [],
              checkedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
              status: "unavailable",
            });
          return false;
        },
      )
      .finally(() => {
        pending = null;
        requestFiber = null;
      });
    return pending;
  };
  const poll = Effect.runFork(
    Effect.promise(refresh).pipe(Effect.repeat(Schedule.spaced("4 hours"))),
  );
  return {
    refresh,
    stop: () => {
      stopped = true;
      Effect.runFork(Fiber.interrupt(poll));
      if (requestFiber) Effect.runFork(Fiber.interrupt(requestFiber));
    },
  };
}
