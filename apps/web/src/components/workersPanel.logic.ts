import type {
  WorkerActivity,
  WorkerApprovalRequest,
  WorkerDetail,
  WorkerId,
  WorkerMessage,
  WorkerObserverReport,
  WorkerStatus,
  WorkerSummary,
  WorkerTimingMetrics,
} from "@t3tools/contracts";

export const ACTIVE_WORKER_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  "starting",
  "running",
  "waitingApproval",
]);

const ACTIVE_STATUS_ORDER: Record<"waitingApproval" | "running" | "starting", number> = {
  waitingApproval: 0,
  running: 1,
  starting: 2,
};

export interface WorkerSections {
  readonly active: ReadonlyArray<WorkerSummary>;
  readonly recent: ReadonlyArray<WorkerSummary>;
}

export function partitionWorkers(workers: ReadonlyArray<WorkerSummary>): WorkerSections {
  const active: Array<WorkerSummary> = [];
  const recent: Array<WorkerSummary> = [];
  for (const worker of workers) {
    (ACTIVE_WORKER_STATUSES.has(worker.status) ? active : recent).push(worker);
  }
  active.sort((left, right) => {
    const rank =
      ACTIVE_STATUS_ORDER[left.status as keyof typeof ACTIVE_STATUS_ORDER] -
      ACTIVE_STATUS_ORDER[right.status as keyof typeof ACTIVE_STATUS_ORDER];
    return rank || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
  recent.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return { active, recent };
}

export function resolveSelectedWorkerId(
  current: WorkerId | null,
  sections: WorkerSections,
): WorkerId | null {
  const ordered = [...sections.active, ...sections.recent];
  if (current !== null && ordered.some((worker) => worker.id === current)) return current;
  return ordered[0]?.id ?? null;
}

export interface WorkerPanelSelectionState {
  readonly selectedWorkerId: WorkerId | null;
  readonly selectedSurface: "overview" | "worker";
  readonly narrowPage: "overview" | "list" | "detail";
}

export function reconcileWorkerPanelSelection(
  state: WorkerPanelSelectionState,
  sections: WorkerSections,
): WorkerPanelSelectionState {
  if (state.selectedWorkerId === null) return state;
  const workers = [...sections.active, ...sections.recent];
  if (workers.some((worker) => worker.id === state.selectedWorkerId)) return state;
  return {
    selectedWorkerId: null,
    selectedSurface: "overview",
    narrowPage: "overview",
  };
}

export const WORKER_MASTER_DETAIL_MIN_WIDTH = 620;

export function workerPanelLayout(width: number): "master-detail" | "drill-in" {
  return width >= WORKER_MASTER_DETAIL_MIN_WIDTH ? "master-detail" : "drill-in";
}

/** Advances only the open-ended portion of canonical server timing metrics. */
export function liveWorkerTiming(timing: WorkerTimingMetrics, nowMs: number): WorkerTimingMetrics {
  const computedAtMs = Date.parse(timing.computedAt);
  const delta = Number.isFinite(computedAtMs) ? Math.max(0, nowMs - computedAtMs) : 0;
  if (delta === 0 || timing.activeActivationCount === 0) return timing;
  const totalWallTimeMs = timing.totalWallTimeMs + delta * timing.activeActivationCount;
  const busyTimeMs = timing.busyTimeMs + delta;
  return {
    ...timing,
    totalWallTimeMs,
    overallSpanMs: timing.overallSpanMs + delta,
    busyTimeMs,
    overlapTimeMs: timing.overlapTimeMs + delta * Math.max(0, timing.activeActivationCount - 1),
    averageConcurrency: busyTimeMs === 0 ? 0 : totalWallTimeMs / busyTimeMs,
    peakConcurrency: Math.max(timing.peakConcurrency, timing.activeActivationCount),
  };
}

export type WorkerTimelineEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly value: WorkerMessage;
    }
  | {
      readonly type: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly value: WorkerActivity;
    }
  | {
      readonly type: "observer";
      readonly id: string;
      readonly createdAt: string;
      readonly value: WorkerObserverReport;
    }
  | {
      readonly type: "approval";
      readonly id: string;
      readonly createdAt: string;
      readonly value: WorkerApprovalRequest;
    };

export function buildWorkerTimeline(detail: WorkerDetail): ReadonlyArray<WorkerTimelineEntry> {
  const entries: Array<WorkerTimelineEntry & { readonly order: number }> = [];
  let order = 0;
  for (const message of detail.messages) {
    entries.push({
      type: "message",
      id: message.id,
      createdAt: message.createdAt,
      value: message,
      order: order++,
    });
  }
  for (const activity of detail.activities) {
    entries.push({
      type: "activity",
      id: activity.id,
      createdAt: activity.createdAt,
      value: activity,
      order: order++,
    });
  }
  for (const report of detail.observerReports) {
    entries.push({
      type: "observer",
      id: report.id,
      createdAt: report.generatedAt,
      value: report,
      order: order++,
    });
  }
  if (
    detail.pendingApproval &&
    !detail.activities.some(
      (activity) =>
        activity.kind === "approval.requested" &&
        activity.createdAt === detail.pendingApproval?.requestedAt,
    )
  ) {
    entries.push({
      type: "approval",
      id: detail.pendingApproval.requestId,
      createdAt: detail.pendingApproval.requestedAt,
      value: detail.pendingApproval,
      order: order++,
    });
  }
  return entries
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.order - right.order,
    )
    .map(({ order: _order, ...entry }) => entry);
}

export function workerToolCallCount(activities: ReadonlyArray<WorkerActivity>): number {
  return activities.filter(
    (activity) =>
      activity.tone === "tool" &&
      (activity.kind === "tool.started" ||
        activity.kind === "tool.updated" ||
        activity.kind === "tool.completed" ||
        activity.kind === "tool.failed"),
  ).length;
}
