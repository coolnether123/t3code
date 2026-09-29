import type {
  UsageBucket,
  UsageDay,
  UsageQuotaCost,
  UsageQuotaCostSnapshot,
  UsageReport,
  UsageReportCalculation,
  UsageReportInput,
  UsageReportModelRow,
  UsageReportQuotaCost,
  UsageReportRunRow,
  UsageReportDailyRunRow,
  UsageReportDailyUnattributedRow,
  UsageReportRuns,
  UsageReportUnattributedRun,
  UsageReportSeriesPoint,
  UsageReportTotals,
  UsagePricing,
  UsageModelPriceOverride,
  UsageProviderKind,
  UsageQuotaInterval,
  UsageSource,
  UsageSummary,
  UsageTokenTotals,
} from "@t3tools/contracts";

import { addTotals, EMPTY_TOTALS } from "./usageTranscripts.ts";

const DEFAULT_PROVIDER_LIMIT = 16;
const DEFAULT_MODEL_LIMIT = 128;
const DEFAULT_SERIES_LIMIT = 366;
const DEFAULT_QUOTA_LIMIT = 256;
const DEFAULT_RUN_LIMIT = 20;
const MAX_RUN_MODELS = 16;
const MAX_PRICE_OVERRIDE_ROWS = 128;

export function makeUsageReportCalculation(
  pricing: UsagePricing,
  overrides: Readonly<Record<string, UsageModelPriceOverride>>,
): UsageReportCalculation {
  const entries = Object.entries(overrides);
  const priceOverrides = entries.slice(0, MAX_PRICE_OVERRIDE_ROWS).map(([model, prices]) => ({
    model,
    ...prices,
  }));
  return {
    formulaVersion: 1,
    costBasis: "apiEquivalent",
    costSemantics:
      "USD-equivalent value at the selected public model rates; this is not a subscription charge.",
    cacheSavingsSemantics:
      "Full uncached input value minus the charged cache-read value for cacheable input tokens.",
    serviceTierPolicy:
      "Transcript or request service-tier metadata selects a tier; unknown metadata uses standard rates.",
    pricing,
    priceOverrides,
    priceOverrideCount: entries.length,
    priceOverridesTruncated: entries.length > MAX_PRICE_OVERRIDE_ROWS,
  };
}

type MutableRollup = {
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  records: number;
  unpricedRecords: number;
  sessions: number;
};

type MutableRunRollup = {
  readonly provider: UsageProviderKind;
  readonly runId: string;
  readonly rollup: MutableRollup;
  readonly models: Set<string>;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
};

type MutableUnattributedRollup = {
  readonly provider: UsageProviderKind;
  readonly rollup: MutableRollup;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
};

const emptyRollup = (): MutableRollup => ({
  totals: EMPTY_TOTALS,
  costUsd: 0,
  cacheSavingsUsd: 0,
  records: 0,
  unpricedRecords: 0,
  sessions: 0,
});

function addBucket(rollup: MutableRollup, bucket: UsageBucket): void {
  rollup.totals = addTotals(rollup.totals, bucket.totals);
  rollup.costUsd += bucket.costUsd;
  rollup.cacheSavingsUsd += bucket.cacheSavingsUsd;
  rollup.records += bucket.records;
  rollup.unpricedRecords += bucket.unpricedRecords;
  rollup.sessions += bucket.sessions;
}

function toTotals(rollup: MutableRollup): UsageReportTotals {
  return {
    totals: rollup.totals,
    costUsd: rollup.costUsd,
    cacheSavingsUsd: rollup.cacheSavingsUsd,
    records: rollup.records,
    pricedRecords: Math.max(0, rollup.records - rollup.unpricedRecords),
    unpricedRecords: rollup.unpricedRecords,
    sessions: rollup.sessions,
  };
}

function addToMap<TKey>(map: Map<TKey, MutableRollup>, key: TKey, bucket: UsageBucket): void {
  const current = map.get(key);
  if (current === undefined) {
    const next = emptyRollup();
    addBucket(next, bucket);
    map.set(key, next);
    return;
  }
  addBucket(current, bucket);
}

function reportLimit(input: UsageReportInput): number {
  if (input.limit !== undefined) return input.limit;
  switch (input.mode) {
    case "providers":
      return DEFAULT_PROVIDER_LIMIT;
    case "models":
      return DEFAULT_MODEL_LIMIT;
    case "series":
      return DEFAULT_SERIES_LIMIT;
    case "quota":
      return DEFAULT_QUOTA_LIMIT;
    case "runs":
      return DEFAULT_RUN_LIMIT;
    default:
      return 1;
  }
}

function updateActivityBounds(
  current: { firstActivityAt: string | null; lastActivityAt: string | null },
  bucket: UsageBucket,
): void {
  for (const timestamp of [bucket.firstActivityAt, bucket.lastActivityAt]) {
    if (timestamp === undefined || !Number.isFinite(Date.parse(timestamp))) continue;
    if (current.firstActivityAt === null || timestamp < current.firstActivityAt) {
      current.firstActivityAt = timestamp;
    }
    if (current.lastActivityAt === null || timestamp > current.lastActivityAt) {
      current.lastActivityAt = timestamp;
    }
  }
}

function runRows(summary: UsageSummary): {
  readonly runs: UsageReportRunRow[];
  readonly dailyRuns: UsageReportDailyRunRow[];
  readonly dailyUnattributed: UsageReportDailyUnattributedRow[];
  readonly unattributed: UsageReportUnattributedRun[];
  readonly attributedRecords: number;
  readonly unattributedRecords: number;
} {
  const runs = new Map<string, MutableRunRollup>();
  const dailyRuns = new Map<string, MutableRollup>();
  const dailyUnattributed = new Map<string, MutableRollup>();
  const unattributed = new Map<UsageProviderKind, MutableUnattributedRollup>();
  let attributedRecords = 0;
  let unattributedRecords = 0;

  for (const bucket of summary.buckets) {
    const runId = bucket.runId;
    if (runId === undefined || runId.trim().length === 0 || runId.length > 512) {
      let row = unattributed.get(bucket.provider);
      if (row === undefined) {
        row = {
          provider: bucket.provider,
          rollup: emptyRollup(),
          firstActivityAt: null,
          lastActivityAt: null,
        };
        unattributed.set(bucket.provider, row);
      }
      addBucket(row.rollup, bucket);
      addToMap(dailyUnattributed, `${bucket.day}\u0000${bucket.provider}`, bucket);
      updateActivityBounds(row, bucket);
      unattributedRecords += bucket.records;
      continue;
    }

    const key = `${bucket.provider}\u0000${runId}`;
    let row = runs.get(key);
    if (row === undefined) {
      row = {
        provider: bucket.provider,
        runId,
        rollup: emptyRollup(),
        models: new Set(),
        firstActivityAt: null,
        lastActivityAt: null,
      };
      runs.set(key, row);
    }
    addBucket(row.rollup, bucket);
    addToMap(dailyRuns, `${bucket.day}\u0000${bucket.provider}\u0000${runId}`, bucket);
    row.models.add(bucket.model);
    updateActivityBounds(row, bucket);
    attributedRecords += bucket.records;
  }

  const rows = [...runs.values()]
    .map((row): UsageReportRunRow => {
      const allModels = [...row.models].sort((left, right) => left.localeCompare(right));
      const rollup = { ...row.rollup, sessions: 1 };
      const totals = toTotals(rollup);
      return {
        provider: row.provider,
        runId: row.runId,
        threadId: null,
        threadMapping: "unavailable",
        models: allModels.slice(0, MAX_RUN_MODELS),
        totalModels: allModels.length,
        modelsTruncated: allModels.length > MAX_RUN_MODELS,
        firstActivityAt: row.firstActivityAt,
        lastActivityAt: row.lastActivityAt,
        ...totals,
        pricingCoverage:
          totals.unpricedRecords === 0
            ? "complete"
            : totals.unpricedRecords === totals.records
              ? "unpriced"
              : "partial",
      };
    })
    .sort(
      (left, right) =>
        right.costUsd - left.costUsd ||
        right.records - left.records ||
        (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "") ||
        left.provider.localeCompare(right.provider) ||
        left.runId.localeCompare(right.runId),
    );

  const unattributedRows = [...unattributed.values()]
    .map((row): UsageReportUnattributedRun => ({
      provider: row.provider,
      firstActivityAt: row.firstActivityAt,
      lastActivityAt: row.lastActivityAt,
      ...toTotals(row.rollup),
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider));

  const dailyRunRows = [...dailyRuns.entries()]
    .map(([key, rollup]): UsageReportDailyRunRow => {
      const [day = "", provider = "", runId = ""] = key.split("\u0000");
      return {
        day: day as UsageDay,
        provider: provider as UsageProviderKind,
        runId,
        threadId: null,
        threadMapping: "unavailable",
        ...toTotals({ ...rollup, sessions: 1 }),
      };
    })
    .sort(
      (left, right) =>
        right.day.localeCompare(left.day) ||
        right.costUsd - left.costUsd ||
        left.provider.localeCompare(right.provider) ||
        left.runId.localeCompare(right.runId),
    );
  const dailyUnattributedRows = [...dailyUnattributed.entries()]
    .map(([key, rollup]): UsageReportDailyUnattributedRow => {
      const [day = "", provider = ""] = key.split("\u0000");
      return { day: day as UsageDay, provider: provider as UsageProviderKind, ...toTotals(rollup) };
    })
    .sort(
      (left, right) =>
        right.day.localeCompare(left.day) || left.provider.localeCompare(right.provider),
    );

  return {
    runs: rows,
    dailyRuns: dailyRunRows,
    dailyUnattributed: dailyUnattributedRows,
    unattributed: unattributedRows,
    attributedRecords,
    unattributedRecords,
  };
}

function sourceCoverageStatus(
  sources: readonly UsageSource[],
  mode: UsageReportInput["mode"],
): "complete" | "partial" | "missing" | "notRequested" {
  if (sources.length === 0)
    return mode === "quota" || mode === "pricing" ? "notRequested" : "missing";
  const failed = sources.some((source) => source.status === "failed");
  const partial = sources.some((source) => source.status === "partial");
  const missing = sources.some((source) => source.status === "missing");
  if (failed || partial || (missing && !sources.every((source) => source.status === "missing"))) {
    return "partial";
  }
  if (sources.every((source) => source.status === "missing")) return "missing";
  return "complete";
}

function projectCoverage(summary: UsageSummary, mode: UsageReportInput["mode"]) {
  const counts = {
    completeSources: 0,
    partialSources: 0,
    missingSources: 0,
    failedSources: 0,
    scannedFiles: 0,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions: 0,
  };
  for (const source of summary.sources) {
    if (source.status === "ok") counts.completeSources += 1;
    if (source.status === "partial") counts.partialSources += 1;
    if (source.status === "missing") counts.missingSources += 1;
    if (source.status === "failed") counts.failedSources += 1;
    counts.scannedFiles += source.scannedFiles;
    counts.skippedFiles += source.skippedFiles;
    counts.malformedRecords += source.malformedRecords;
    counts.distinctSessions += source.distinctSessions;
  }
  const records = summary.buckets.reduce((total, bucket) => total + bucket.records, 0);
  const unpricedRecords = summary.buckets.reduce(
    (total, bucket) => total + bucket.unpricedRecords,
    0,
  );
  return {
    status: sourceCoverageStatus(summary.sources, mode),
    sourceCount: summary.sources.length,
    ...counts,
    records,
    pricedRecords: Math.max(0, records - unpricedRecords),
    unpricedRecords,
  } as const;
}

function calculationEnvelope(
  summary: UsageSummary,
  input: UsageReportInput,
  calculation: UsageReportCalculation,
  coverage: ReturnType<typeof projectCoverage>,
) {
  return {
    contractVersion: 1 as const,
    mode: input.mode,
    readAt: summary.readAt,
    timeZone: summary.timeZone,
    sinceDay: summary.sinceDay,
    untilDay: summary.untilDay,
    scanDurationMs: summary.scanDurationMs,
    calculation,
    coverage,
  };
}

function compareRollups(
  left: { readonly key: string; readonly rollup: MutableRollup },
  right: { readonly key: string; readonly rollup: MutableRollup },
): number {
  return (
    right.rollup.costUsd - left.rollup.costUsd ||
    right.rollup.records - left.rollup.records ||
    left.key.localeCompare(right.key)
  );
}

function modelRows(summary: UsageSummary): UsageReportModelRow[] {
  const rows = new Map<string, MutableRollup>();
  for (const bucket of summary.buckets)
    addToMap(rows, `${bucket.provider}\u0000${bucket.model}`, bucket);
  return [...rows.entries()]
    .map(([key, rollup]) => {
      const [provider = "", model = ""] = key.split("\u0000");
      return {
        provider: provider as UsageProviderKind,
        model,
        ...toTotals(rollup),
      } as UsageReportModelRow;
    })
    .sort((left, right) =>
      compareRollups(
        { key: `${left.provider}\u0000${left.model}`, rollup: left },
        { key: `${right.provider}\u0000${right.model}`, rollup: right },
      ),
    );
}

function providerRows(summary: UsageSummary) {
  const rows = new Map<string, MutableRollup>();
  for (const bucket of summary.buckets) addToMap(rows, bucket.provider, bucket);
  return [...rows.entries()]
    .map(([provider, rollup]) => ({
      provider: provider as UsageProviderKind,
      ...toTotals(rollup),
    }))
    .sort((left, right) =>
      compareRollups({ key: left.provider, rollup: left }, { key: right.provider, rollup: right }),
    );
}

function seriesPoints(
  summary: UsageSummary,
  resolution: UsageReportInput["resolution"] = "day",
): UsageReportSeriesPoint[] {
  const rows = new Map<string, MutableRollup>();
  for (const bucket of summary.buckets) {
    const key = `${bucket.day}\u0000${resolution === "hour" ? (bucket.hourStart ?? "") : ""}`;
    addToMap(rows, key, bucket);
  }
  return [...rows.entries()]
    .map(([key, rollup]) => {
      const [day = "", hourStart = ""] = key.split("\u0000");
      return {
        day,
        ...(hourStart === "" ? {} : { hourStart }),
        ...toTotals(rollup),
      } as UsageReportSeriesPoint;
    })
    .sort(
      (left, right) =>
        left.day.localeCompare(right.day) ||
        (left.hourStart ?? "").localeCompare(right.hourStart ?? ""),
    );
}

function quotaModels(
  models: readonly {
    readonly model: string;
    readonly totals: UsageTokenTotals;
    readonly costUsd: number;
    readonly records: number;
    readonly unpricedRecords: number;
  }[],
): UsageReportModelRow[] {
  return models
    .map((model): UsageReportModelRow => ({
      provider: "codex",
      model: model.model,
      totals: model.totals,
      costUsd: model.costUsd,
      cacheSavingsUsd: 0,
      records: model.records,
      pricedRecords: Math.max(0, model.records - model.unpricedRecords),
      unpricedRecords: model.unpricedRecords,
      sessions: 0,
    }))
    .sort(
      (left, right) =>
        right.costUsd - left.costUsd ||
        right.records - left.records ||
        left.model.localeCompare(right.model),
    );
}

function quotaCost(
  row: UsageQuotaCost | UsageQuotaCostSnapshot,
  limit: number,
  history: UsageSummary["quotaHistory"],
  intervals: readonly UsageQuotaInterval[],
): UsageReportQuotaCost | null {
  const interval =
    "sinceTime" in row ? row : intervals.find((candidate) => candidate.id === row.intervalId);
  if (interval === undefined) return null;
  const first = interval
    ? history?.samples.find((sample) => sample.observedAt === interval.sinceTime)
    : undefined;
  const last = interval
    ? history?.samples.find((sample) => sample.observedAt === interval.untilTime)
    : undefined;
  const models = quotaModels(row.models ?? []);
  const source = "complete" in row ? row.complete : true;
  const unpricedRecords = "unpricedRecords" in row ? row.unpricedRecords : 0;
  return {
    intervalId: row.intervalId,
    fingerprint: row.fingerprint,
    sinceTime: interval.sinceTime,
    untilTime: interval.untilTime,
    costUsd: row.costUsd,
    records: row.records,
    pricedRecords: Math.max(0, row.records - unpricedRecords),
    unpricedRecords,
    complete: source,
    firstRemainingPercent:
      "firstRemainingPercent" in row
        ? row.firstRemainingPercent
        : (first?.remainingPercent ?? null),
    lastRemainingPercent:
      "lastRemainingPercent" in row ? row.lastRemainingPercent : (last?.remainingPercent ?? null),
    resetsAt: "resetsAt" in row ? row.resetsAt : (first?.resetsAt ?? null),
    models: models.slice(0, limit),
    totalModels: models.length,
    modelsTruncated: models.length > limit,
  } as UsageReportQuotaCost;
}

function quotaCosts(
  summary: UsageSummary,
  limit: number,
  intervals: readonly UsageQuotaInterval[],
): UsageReportQuotaCost[] {
  const deduped = new Map<string, UsageQuotaCost | UsageQuotaCostSnapshot>();
  // Durable snapshots provide history when no live interval was requested;
  // live rows win for an interval because they reflect the just-finished scan.
  for (const row of [...(summary.quotaCostSnapshots ?? []), ...(summary.quotaCosts ?? [])]) {
    const key = `${row.intervalId}\u0000${JSON.stringify(row.fingerprint)}`;
    deduped.set(key, row);
  }
  return [...deduped.values()]
    .map((row) => quotaCost(row, limit, summary.quotaHistory, intervals))
    .filter((row): row is UsageReportQuotaCost => row !== null)
    .sort(
      (left, right) =>
        left.sinceTime.localeCompare(right.sinceTime) ||
        left.intervalId.localeCompare(right.intervalId),
    );
}

/** Projects a provider-backed summary into one bounded agent response. */
export function projectUsageReport(
  summary: UsageSummary,
  input: UsageReportInput,
  calculation: UsageReportCalculation,
): UsageReport {
  const coverage = projectCoverage(summary, input.mode);
  const envelope = calculationEnvelope(summary, input, calculation, coverage);

  switch (input.mode) {
    case "overview": {
      const total = emptyRollup();
      for (const bucket of summary.buckets) addBucket(total, bucket);
      // Source-level distinct sessions do not double-count a session that spans
      // days or models; use the bucket sum only for summaries without sources.
      total.sessions =
        summary.sources.length === 0
          ? total.sessions
          : summary.sources.reduce((sum, source) => sum + source.distinctSessions, 0);
      return { ...envelope, mode: "overview", totals: toTotals(total) };
    }
    case "providers": {
      const rows = providerRows(summary);
      const limit = reportLimit(input);
      return {
        ...envelope,
        mode: "providers",
        rows: rows.slice(0, limit),
        totalRows: rows.length,
        truncated: rows.length > limit,
      };
    }
    case "models": {
      const rows = modelRows(summary);
      const limit = reportLimit(input);
      return {
        ...envelope,
        mode: "models",
        rows: rows.slice(0, limit),
        totalRows: rows.length,
        truncated: rows.length > limit,
      };
    }
    case "series": {
      const points = seriesPoints(summary, input.resolution);
      const limit = reportLimit(input);
      return {
        ...envelope,
        mode: "series",
        resolution: input.resolution ?? "day",
        points: points.slice(-limit),
        totalPoints: points.length,
        truncated: points.length > limit,
      };
    }
    case "quota": {
      const limit = reportLimit(input);
      const history = summary.quotaHistory ?? {
        status: "missing" as const,
        source: "Not requested",
        samples: [],
        message: "Quota history was not returned by the server.",
      };
      const samples = history.samples;
      const costs = quotaCosts(summary, limit, input.quotaIntervals ?? []);
      return {
        ...envelope,
        mode: "quota",
        quotaHistory: {
          ...history,
          samples: samples.slice(-limit),
        },
        samplesTruncated: samples.length > limit,
        totalSamples: samples.length,
        costs: costs.slice(-limit),
        totalCosts: costs.length,
        costsTruncated: costs.length > limit,
      };
    }
    case "pricing":
      return { ...envelope, mode: "pricing" };
    case "runs": {
      const projected = runRows(summary);
      const filtered = input.runIds !== undefined;
      const runs = filtered
        ? projected.runs.filter((run) => input.runIds!.includes(run.runId))
        : projected.runs;
      const dailyRuns = filtered
        ? projected.dailyRuns.filter((row) => input.runIds!.includes(row.runId))
        : projected.dailyRuns;
      const limit = reportLimit(input);
      const unattributed = filtered ? [] : projected.unattributed;
      const attributedRecords = filtered
        ? runs.reduce((total, run) => total + run.records, 0)
        : projected.attributedRecords;
      const unattributedRecords = filtered ? 0 : projected.unattributedRecords;
      const report: UsageReportRuns = {
        ...envelope,
        mode: "runs",
        runs: runs.slice(0, limit),
        totalRuns: runs.length,
        truncated: runs.length > limit,
        dailyRuns: dailyRuns.slice(0, limit),
        totalDailyRuns: dailyRuns.length,
        dailyRunsTruncated: dailyRuns.length > limit,
        dailyUnattributed: filtered ? [] : projected.dailyUnattributed.slice(0, limit),
        totalDailyUnattributed: filtered ? 0 : projected.dailyUnattributed.length,
        dailyUnattributedTruncated: !filtered && projected.dailyUnattributed.length > limit,
        unattributed,
        runCoverage: {
          status: filtered ? "filtered" : unattributedRecords > 0 ? "partial" : "complete",
          records: attributedRecords + unattributedRecords,
          attributedRecords,
          unattributedRecords,
          distinctRuns: runs.length,
        },
        threadMappingStatus: "notRequested",
      };
      return report;
    }
  }
}
