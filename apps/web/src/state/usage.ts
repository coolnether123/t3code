import { needsCursorKeychainAccess } from "@t3tools/client-runtime/state/usage";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import { environmentSession } from "./session";
/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { usageQueryInput } from "@t3tools/client-runtime/usageRefresh";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStableCallback } from "../hooks/useStableCallback";

import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const DEFERRED_TRANSCRIPT_REFRESH_BASE_MS = 750;
const DEFERRED_TRANSCRIPT_REFRESH_MAX_MS = 8_000;
const MAX_FAILED_REFRESHES = 5;

const isDeferredTranscriptSource = (
  source: NonNullable<EnvironmentUsageStatus["summary"]>["sources"][number],
) =>
  source.status === "partial" &&
  /\bdeferred\b|response budget|complete-line chunks/i.test(source.message ?? "");

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly canReadDiagnostics: boolean;
  readonly isConnected: boolean;
  readonly needsCursorKeychainAccess: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

/**
 * Reads every environment's summary for one window.
 *
 * Keyed by the serialised window so switching ranges does not thrash the atom
 * cache, and so each environment's query is shared with any other reader of the
 * same window.
 */
const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const isConnected = presentation.connection.phase === "connected";
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const access = resolveUsageAccess({
        connectionPhase: presentation.connection.phase,
        session: Option.getOrNull(AsyncResult.value(sessionResult)),
        hasSessionError: sessionResult._tag === "Failure",
      });
      if (!access.canReadDiagnostics) {
        statuses.push({
          environmentId,
          label: presentation.entry.target.label,
          connection: presentation.connection,
          isConnected,
          ...access,
          summary: null,
          needsCursorKeychainAccess: false,
        });
        continue;
      }
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      const summary = Option.getOrNull(AsyncResult.value(result));
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        connection: presentation.connection,
        isPending: result.waiting,
        canReadDiagnostics: true,
        isConnected,
        error: result._tag === "Failure" ? "This environment could not report usage." : null,
        summary,
        needsCursorKeychainAccess: needsCursorKeychainAccess(
          summary,
          get(serverEnvironment.providersValueAtom(environmentId)),
        ),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly shown: { readonly window: UsageSummaryInput; readonly merged: MergedUsage } | null;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported through their own error rows: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<readonly EnvironmentUsageStatus[]>;
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  hiddenProviders: ReadonlySet<UsageProviderKind> = NO_HIDDEN_PROVIDERS,
): UsageView {
  const windowKey = (() => JSON.stringify(usageQueryInput(input, USAGE_CONTRACT_VERSION)))();
  const atom = usageByWindowAtom(windowKey);
  const observedEnvironments = useAtomValue(atom);
  const [refreshed, setRefreshed] = useState<{
    readonly windowKey: string;
    readonly generation: number;
    readonly statuses: readonly EnvironmentUsageStatus[];
    readonly baselineReadAt: ReadonlyMap<string, string | undefined>;
  } | null>(null);
  const environments = (() => {
    if (refreshed?.windowKey !== windowKey) return observedEnvironments;
    const byId = new Map(refreshed.statuses.map((status) => [status.environmentId, status]));
    return observedEnvironments.map((environment) => {
      const refreshedEnvironment = byId.get(environment.environmentId);
      if (refreshedEnvironment === undefined) return environment;
      const observedAt = environment.summary?.readAt;
      const refreshedAt = refreshedEnvironment.summary?.readAt;
      const baselineAt = refreshed.baselineReadAt.get(environment.environmentId);
      // Imperative refreshes are kept locally because the shared atom can
      // finish on a later turn. Once that atom has a newer server reading,
      // let it win so a refresh cannot pin the page to an older answer.
      if (
        observedAt !== undefined &&
        ((refreshedAt !== undefined && observedAt > refreshedAt) ||
          (refreshedAt === undefined && observedAt !== baselineAt))
      ) {
        return environment;
      }
      return { ...refreshedEnvironment, connection: environment.connection };
    });
  })();
  const selectedEnvironments = (() =>
    selectedEnvironmentIds === null
      ? environments
      : environments.filter((environment) =>
          selectedEnvironmentIds.has(environment.environmentId),
        ))();
  const retriedFailures = useRef(new Set<string>());
  const delayedRetries = useRef(new Set<string>());
  const delayedRetryTimers = useRef(new Map<string, ReturnType<typeof globalThis.setTimeout>>());
  const deferredTranscriptRetry = useRef({
    windowKey,
    signature: "",
    stalledAttempts: 0,
    failedAttempts: 0,
    timer: null as ReturnType<typeof globalThis.setTimeout> | null,
  });
  const refreshInFlight = useRef<{
    readonly requestWindowKey: string;
    readonly promise: Promise<readonly EnvironmentUsageStatus[]>;
  } | null>(null);
  const refreshGeneration = useRef(0);
  const windowKeyRef = useRef(windowKey);
  const refreshAfterCommit = useRef<UsageView["refresh"] | null>(null);
  useLayoutEffect(() => {
    windowKeyRef.current = windowKey;
  }, [windowKey]);

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the button always rescans.
  const refresh = useStableCallback(async (nextInput?: UsageSummaryInput) => {
    const input = nextInput
      ? usageQueryInput(nextInput, USAGE_CONTRACT_VERSION)
      : (JSON.parse(windowKey) as UsageSummaryInput);
    const requestWindowKey = JSON.stringify(input);
    const inFlight = refreshInFlight.current;
    if (inFlight?.requestWindowKey === requestWindowKey) {
      return inFlight.promise;
    }
    const requestInput = { ...input, refresh: nextInput?.refresh ?? true };
    const generation = refreshGeneration.current + 1;
    refreshGeneration.current = generation;
    const baselineReadAt = new Map(
      environments.map((environment) => [environment.environmentId, environment.summary?.readAt]),
    );
    const requestStatuses = environments.map((environment) =>
      requestWindowKey === windowKey
        ? { ...environment, isPending: true }
        : { ...environment, isPending: true, error: null, summary: null },
    );
    setRefreshed({
      windowKey: requestWindowKey,
      generation,
      statuses: requestStatuses,
      baselineReadAt,
    });
    const promise = (async () => {
      const statuses = await Promise.all(
        environments.map(async (environment) => {
          const result = await executeAtomQuery(
            appAtomRegistry,
            serverEnvironment.usageSummary({
              environmentId: environment.environmentId,
              input: requestInput,
            }),
            { refresh: true, reportFailure: false, reportDefect: false },
          );
          const status = {
            ...environment,
            isPending: false,
            error: result._tag === "Failure" ? "This environment could not report usage." : null,
            summary:
              result._tag === "Failure" && requestWindowKey === windowKey
                ? environment.summary
                : Option.getOrNull(AsyncResult.value(result)),
          };
          setRefreshed((previous) => {
            if (previous?.generation !== generation) return previous;
            const nextStatuses = previous.statuses.map((entry) =>
              entry.environmentId === status.environmentId ? status : entry,
            );
            return { ...previous, statuses: nextStatuses };
          });
          return status;
        }),
      );
      setRefreshed((previous) =>
        previous?.generation === generation
          ? { ...previous, windowKey: requestWindowKey, statuses }
          : previous,
      );
      return statuses;
    })();
    refreshInFlight.current = { requestWindowKey, promise };
    const settleInFlight = (statuses?: readonly EnvironmentUsageStatus[]) => {
      if (refreshInFlight.current?.promise === promise) refreshInFlight.current = null;
      if (
        statuses?.some((status) => status.error !== null) === true &&
        windowKeyRef.current === requestWindowKey
      ) {
        const pendingRetryKeys = [...delayedRetries.current].filter((retryKey) =>
          retryKey.startsWith(`${requestWindowKey}:`),
        );
        for (const retryKey of pendingRetryKeys) delayedRetries.current.delete(retryKey);
        if (pendingRetryKeys.length > 0) void refreshAfterCommit.current?.();
      }
    };
    void promise.then(settleInFlight, () => settleInFlight());
    return promise;
  });
  useLayoutEffect(() => {
    refreshAfterCommit.current = refresh;
  }, [refresh]);

  // Route navigation can remount this view while its shared atom still holds a
  // transient disconnected result. Retry that result once on entry so mobile
  // users do not need to reload the whole browser tab.
  useEffect(() => {
    const failedIds = environments
      .filter((environment) => environment.error !== null && !environment.isPending)
      .map((environment) => environment.environmentId)
      .sort();
    if (failedIds.length === 0) {
      // A refresh keeps a prior error on its pending overlay so the delayed
      // reconnect retry survives until the request settles. Do not clear its
      // budget or timer merely because that overlay is pending.
      if (environments.some((environment) => environment.error !== null)) return;
      // A successful reading closes the previous reconnect episode; a later
      // disconnect must be eligible for its own recovery retry.
      retriedFailures.current.clear();
      delayedRetries.current.clear();
      for (const timer of delayedRetryTimers.current.values()) globalThis.clearTimeout(timer);
      delayedRetryTimers.current.clear();
      return;
    }
    const retryKey = `${windowKey}:${failedIds.join(",")}`;
    if (delayedRetries.current.has(retryKey)) {
      if (refreshInFlight.current?.requestWindowKey === windowKey) return;
      // The delayed retry elapsed while the first recovery request was still
      // active. Consume it once after that request settles, without resetting
      // the episode budget and allowing an unbounded retry loop.
      delayedRetries.current.delete(retryKey);
      void refresh();
      return;
    }
    if (retriedFailures.current.has(retryKey)) return;
    retriedFailures.current.add(retryKey);
    void refresh();
    // A first read can be interrupted while a remote WebSocket is reconnecting.
    // Keep one delayed retry alive across the transient pending/error renders.
    const timer = globalThis.setTimeout(() => {
      delayedRetryTimers.current.delete(retryKey);
      if (windowKeyRef.current !== windowKey) return;
      if (refreshInFlight.current?.requestWindowKey === windowKey) {
        // The first recovery request is still active. Let its settled result
        // drive this effect so a slow scan cannot be duplicated. The marker
        // is consumed by that settled result exactly once.
        delayedRetries.current.add(retryKey);
        return;
      }
      void refresh();
    }, 3_000);
    delayedRetryTimers.current.set(retryKey, timer);
  }, [environments, refresh, windowKey]);

  useEffect(() => {
    const timers = delayedRetryTimers.current;
    return () => {
      for (const [retryKey, timer] of timers) {
        if (!retryKey.startsWith(`${windowKey}:`)) continue;
        globalThis.clearTimeout(timer);
        timers.delete(retryKey);
      }
      for (const retryKey of delayedRetries.current) {
        if (retryKey.startsWith(`${windowKey}:`)) delayedRetries.current.delete(retryKey);
      }
      const deferred = deferredTranscriptRetry.current;
      if (deferred.windowKey === windowKey) {
        if (deferred.timer !== null) globalThis.clearTimeout(deferred.timer);
        deferred.timer = null;
      }
    };
  }, [windowKey, delayedRetryTimers, delayedRetries]);

  const hiddenProviderKey = JSON.stringify([...hiddenProviders].sort());
  const selectionKey = JSON.stringify(
    selectedEnvironmentIds === null ? null : [...selectedEnvironmentIds].sort(),
  );
  const merged = (() =>
    mergeAnsweredUsage(withoutProviders(selectedEnvironments, hiddenProviders)))();

  const hasDeferredTranscripts = selectedEnvironments.some(
    (environment) =>
      environment.isConnected &&
      (environment.error !== null || environment.summary?.sources.some(isDeferredTranscriptSource)),
  );

  // A bounded server scan intentionally returns partial data while its cache is
  // cold. Keep advancing that cache while the Usage page is mounted so totals
  // converge without asking the user to click Refresh once per 128 MiB batch.
  useEffect(() => {
    const retry = deferredTranscriptRetry.current;
    if (retry.windowKey !== windowKey) {
      if (retry.timer !== null) globalThis.clearTimeout(retry.timer);
      retry.windowKey = windowKey;
      retry.signature = "";
      retry.stalledAttempts = 0;
      retry.failedAttempts = 0;
      retry.timer = null;
    }
    if (!hasDeferredTranscripts) {
      if (retry.timer !== null) globalThis.clearTimeout(retry.timer);
      retry.signature = "";
      retry.stalledAttempts = 0;
      retry.failedAttempts = 0;
      retry.timer = null;
      return;
    }
    const deferredSignature = selectedEnvironments
      .flatMap((environment) =>
        (environment.summary?.sources ?? [])
          .filter(isDeferredTranscriptSource)
          .map(
            (source) =>
              `${environment.environmentId}:${source.fingerprint.resolvedHomePath}:${source.scannedFiles}:${source.skippedFiles}:${source.message ?? ""}`,
          ),
      )
      .sort()
      .join("|");
    if (retry.signature !== deferredSignature) {
      retry.signature = deferredSignature;
      retry.stalledAttempts = 0;
    }
    const failed = selectedEnvironments.some((environment) => environment.error !== null);
    if (!failed) retry.failedAttempts = 0;
    if (failed && retry.failedAttempts >= MAX_FAILED_REFRESHES) return;
    const waitingOrFailed = selectedEnvironments.some((environment) => environment.isPending);
    if (waitingOrFailed) {
      if (retry.timer !== null) globalThis.clearTimeout(retry.timer);
      retry.timer = null;
      return;
    }
    if (retry.timer !== null) {
      return;
    }
    const delay = Math.min(
      DEFERRED_TRANSCRIPT_REFRESH_MAX_MS,
      DEFERRED_TRANSCRIPT_REFRESH_BASE_MS * 2 ** Math.min(retry.stalledAttempts, 4),
    );
    retry.timer = globalThis.setTimeout(() => {
      retry.timer = null;
      if (windowKeyRef.current !== windowKey) return;
      retry.stalledAttempts += 1;
      if (failed) retry.failedAttempts += 1;
      void refresh({
        ...(JSON.parse(windowKey) as UsageSummaryInput),
        refresh: false,
      });
    }, delay);
  }, [selectedEnvironments, hasDeferredTranscripts, refresh, windowKey]);

  const answeredCount = selectedEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = selectedEnvironments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  const [lastAnswered, setLastAnswered] = useState<{
    readonly window: UsageSummaryInput;
    readonly merged: MergedUsage;
    readonly selectionKey: string;
    readonly windowKey: string;
    readonly hiddenProviderKey: string;
  } | null>(null);
  if (
    answeredCount > 0 &&
    (lastAnswered?.merged !== merged ||
      lastAnswered.windowKey !== windowKey ||
      lastAnswered.selectionKey !== selectionKey ||
      lastAnswered.hiddenProviderKey !== hiddenProviderKey)
  ) {
    setLastAnswered({ window: input, merged, windowKey, selectionKey, hiddenProviderKey });
  } else if (
    lastAnswered !== null &&
    (lastAnswered.selectionKey !== selectionKey ||
      lastAnswered.hiddenProviderKey !== hiddenProviderKey)
  ) {
    setLastAnswered(null);
  }
  return {
    merged,
    shown:
      answeredCount > 0
        ? { window: input, merged }
        : lastAnswered?.selectionKey === selectionKey &&
            lastAnswered.hiddenProviderKey === hiddenProviderKey
          ? lastAnswered
          : null,
    environments,
    selectedEnvironments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}

export function mergeAnsweredUsage(
  environments: readonly EnvironmentUsageStatus[],
  keepBucket?: (bucket: UsageBucket) => boolean,
): MergedUsage {
  const answered: EnvironmentUsage[] = environments.flatMap(({ environmentId, label, summary }) =>
    summary === null
      ? []
      : [
          {
            environmentId,
            label,
            summary:
              keepBucket === undefined
                ? summary
                : { ...summary, buckets: summary.buckets.filter(keepBucket) },
          },
        ],
  );
  return mergeUsage(answered, USAGE_CONTRACT_VERSION);
}

const NO_HIDDEN_PROVIDERS: ReadonlySet<UsageProviderKind> = new Set();

function withoutProviders(
  environments: readonly EnvironmentUsageStatus[],
  hiddenProviders: ReadonlySet<UsageProviderKind>,
): readonly EnvironmentUsageStatus[] {
  if (hiddenProviders.size === 0) return environments;
  return environments.map((environment) =>
    environment.summary === null
      ? environment
      : {
          ...environment,
          summary: {
            ...environment.summary,
            buckets: environment.summary.buckets.filter(
              (bucket) => !hiddenProviders.has(bucket.provider),
            ),
            sources: environment.summary.sources.filter(
              (source) => !hiddenProviders.has(source.fingerprint.provider),
            ),
          },
        },
  );
}
