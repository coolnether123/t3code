/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { executeAtomQuery, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { usageQueryInput } from "@t3tools/client-runtime/usageRefresh";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

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
  /** True until at least one selected environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported through their own error rows: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: (
    input?: UsageSummaryInput,
    refreshRates?: boolean,
  ) => Promise<readonly EnvironmentUsageStatus[]>;
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
  const environments = useAtomValue(atom);
  const retriedFailures = useRef(new Set<string>());
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter((environment) =>
            selectedEnvironmentIds.has(environment.environmentId),
          ),
    [environments, selectedEnvironmentIds],
  );

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the button always rescans.
  //
  // Each environment refetches model pricing first, so a model released since
  // its last daily fetch gets priced by the rescan. The rescan runs whether or
  // not the refetch succeeds: an offline environment still recounts tokens.
  const refresh = useCallback(
    async (nextInput?: UsageSummaryInput, refreshRates = true) => {
      const input = nextInput
        ? usageQueryInput(nextInput, USAGE_CONTRACT_VERSION)
        : (JSON.parse(windowKey) as UsageSummaryInput);
      const requestInput = { ...input, refresh: nextInput?.refresh ?? true };
      return Promise.all(
        selectedEnvironments.map(async (environment) => {
          const { environmentId } = environment;
          if (refreshRates && !input.quotaHistoryOnly) {
            await runAtomCommand(
              appAtomRegistry,
              serverEnvironment.refreshUsageRates,
              { environmentId, input: {} },
              { reportFailure: false },
            );
          }
          const result = await executeAtomQuery(
            appAtomRegistry,
            serverEnvironment.usageSummary({ environmentId, input: requestInput }),
            { refresh: true, timeoutMs: 30_000, reportFailure: false, reportDefect: false },
          );
          // A forced scan has a distinct request key. Invalidate the query
          // observed by this view so it reads the freshly computed server cache.
          appAtomRegistry.refresh(
            serverEnvironment.usageSummary({
              environmentId,
              input: JSON.parse(windowKey) as UsageSummaryInput,
            }),
          );
          return {
            ...environment,
            isPending: false,
            error: result._tag === "Failure" ? "This environment could not report usage." : null,
            summary: Option.getOrNull(AsyncResult.value(result)),
          };
        }),
      );
    },
    [selectedEnvironments, windowKey],
  );

  // A retained connection failure should recover when this route is reopened.
  // Retry each failed set once per window, without refetching public prices.
  useEffect(() => {
    const failedIds = selectedEnvironments
      .filter((environment) => environment.error !== null)
      .map((environment) => environment.environmentId)
      .sort();
    if (failedIds.length === 0) return;
    const retryKey = `${windowKey}:${failedIds.join(",")}`;
    if (retriedFailures.current.has(retryKey)) return;
    retriedFailures.current.add(retryKey);
    void refresh(undefined, false);
  }, [selectedEnvironments, refresh, windowKey]);

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = selectedEnvironments.flatMap((environment) =>
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
  }, [selectedEnvironments]);

  const hasDeferredTranscripts = selectedEnvironments.some((environment) =>
    environment.summary?.sources.some((source) => source.status === "partial"),
  );
  useEffect(() => {
    if (
      !hasDeferredTranscripts ||
      selectedEnvironments.some((environment) => environment.isPending)
    )
      return;
    // Continue bounded scans without re-fetching public prices for every batch.
    const timer = setTimeout(
      () =>
        void refresh({ ...(JSON.parse(windowKey) as UsageSummaryInput), refresh: false }, false),
      750,
    );
    return () => clearTimeout(timer);
  }, [selectedEnvironments, hasDeferredTranscripts, refresh, windowKey]);

  const answeredCount = selectedEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = selectedEnvironments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
