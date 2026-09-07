/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { usageQueryInput } from "@t3tools/client-runtime/usageRefresh";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
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
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        error: result._tag === "Failure" ? "This environment could not report usage." : null,
        summary: Option.getOrNull(AsyncResult.value(result)),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
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
): UsageView {
  const windowKey = useMemo(
    () => JSON.stringify(usageQueryInput(input, USAGE_CONTRACT_VERSION)),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
      input.includeQuotaHistory,
      input.quotaHistoryOnly,
      input.quotaIntervals,
    ],
  );
  const atom = usageByWindowAtom(windowKey);
  const observedEnvironments = useAtomValue(atom);
  const selectedObservedEnvironments =
    selectedEnvironmentIds === null
      ? observedEnvironments
      : observedEnvironments.filter((environment) =>
          selectedEnvironmentIds.has(environment.environmentId),
        );
  const [refreshed, setRefreshed] = useState<{
    readonly windowKey: string;
    readonly generation: number;
    readonly statuses: readonly EnvironmentUsageStatus[];
    readonly baselineReadAt: ReadonlyMap<string, string | undefined>;
  } | null>(null);
  const environments = useMemo(() => {
    if (refreshed?.windowKey !== windowKey) return selectedObservedEnvironments;
    const byId = new Map(refreshed.statuses.map((status) => [status.environmentId, status]));
    return selectedObservedEnvironments.map((environment) => {
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
      return refreshedEnvironment;
    });
  }, [selectedObservedEnvironments, refreshed, windowKey]);
  const retriedFailures = useRef(new Set<string>());
  const delayedRetryTimers = useRef(new Map<string, number>());
  const refreshGeneration = useRef(0);
  const windowKeyRef = useRef(windowKey);
  windowKeyRef.current = windowKey;

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the button always rescans.
  const refresh = useCallback(
    async (nextInput?: UsageSummaryInput) => {
      const input = nextInput
        ? usageQueryInput(nextInput, USAGE_CONTRACT_VERSION)
        : (JSON.parse(windowKey) as UsageSummaryInput);
      const requestWindowKey = JSON.stringify(input);
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
    },
    [environments, windowKey],
  );

  // Route navigation can remount this view while its shared atom still holds a
  // transient disconnected result. Retry that result once on entry so mobile
  // users do not need to reload the whole browser tab.
  useEffect(() => {
    const failedIds = environments
      .filter((environment) => environment.error !== null)
      .map((environment) => environment.environmentId)
      .sort();
    if (failedIds.length === 0) {
      // A successful reading closes the previous reconnect episode; a later
      // disconnect must be eligible for its own recovery retry.
      retriedFailures.current.clear();
      for (const timer of delayedRetryTimers.current.values()) window.clearTimeout(timer);
      delayedRetryTimers.current.clear();
      return;
    }
    const retryKey = `${windowKey}:${failedIds.join(",")}`;
    if (retriedFailures.current.has(retryKey)) return;
    retriedFailures.current.add(retryKey);
    void refresh();
    // A first read can be interrupted while a remote WebSocket is reconnecting.
    // Keep one delayed retry alive across the transient pending/error renders.
    const timer = window.setTimeout(() => {
      delayedRetryTimers.current.delete(retryKey);
      if (windowKeyRef.current !== windowKey) return;
      void refresh();
    }, 3_000);
    delayedRetryTimers.current.set(retryKey, timer);
  }, [environments, refresh, windowKey]);

  useEffect(() => {
    const timers = delayedRetryTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, [windowKey]);

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = environments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: environment.summary,
            },
          ],
    );
    return mergeUsage(answered, USAGE_CONTRACT_VERSION);
  }, [environments]);

  const hasDeferredTranscripts = environments.some((environment) =>
    environment.summary?.sources.some((source) => source.status === "partial"),
  );

  // A bounded server scan intentionally returns partial data while its cache is
  // cold. Keep advancing that cache while the Usage page is mounted so totals
  // converge without asking the user to click Refresh once per 128 MiB batch.
  useEffect(() => {
    if (!hasDeferredTranscripts || environments.some((environment) => environment.isPending)) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh({
        ...(JSON.parse(windowKey) as UsageSummaryInput),
        refresh: false,
      });
    }, 750);
    return () => window.clearTimeout(timer);
  }, [environments, hasDeferredTranscripts, refresh]);

  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    environments,
    selectedEnvironments: environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
