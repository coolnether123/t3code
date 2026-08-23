import {
  T3_WORKER_TOOL_NAMES,
  type OrchestrationThreadActivity,
  type T3WorkerToolName,
  type WorkerStatus,
} from "@t3tools/contracts";

export { T3_WORKER_TOOL_NAMES, type T3WorkerToolName } from "@t3tools/contracts";
export type WorkerToolCallState = "inProgress" | "completed" | "failed" | "unknown";

export interface WorkerToolIdentity {
  readonly id: string;
  readonly name: string;
  readonly assignment?: string;
  readonly status?: WorkerStatus;
  readonly model?: string;
}

export interface WorkerToolCallPresentation {
  readonly toolName: T3WorkerToolName;
  readonly action: string;
  readonly state: WorkerToolCallState;
  readonly workerIds: ReadonlyArray<string>;
  readonly workers: ReadonlyArray<WorkerToolIdentity>;
  readonly assignment?: string;
  readonly resultSummary?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly callId?: string;
  /** Complete projected MCP data, shown only in Advanced/details UI. */
  readonly rawData?: unknown;
}

export interface ActiveWorkerWait extends WorkerToolCallPresentation {
  readonly toolName: "worker_wait";
  readonly timeoutMillis?: number;
  readonly mode?: string;
  readonly wakeReasons: ReadonlyArray<string>;
  readonly deadlineAt?: string;
  readonly latestEvent?: string;
}

const ACTIONS: Record<T3WorkerToolName, string> = {
  worker_start: "Started Worker",
  worker_list: "Listed Workers",
  worker_status: "Checked Worker status",
  worker_observe: "Observed Worker",
  worker_send: "Sent Worker follow-up",
  worker_wait: "Waiting on Worker",
  worker_interrupt: "Interrupted Worker",
  worker_close: "Closed Worker",
  worker_approval_respond: "Responded to Worker approval",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectOrJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return record(value);
}

function workerName(worker: Record<string, unknown>): string | undefined {
  return text(worker.displayName) ?? text(worker.title) ?? text(worker.name);
}

function workerStatus(value: unknown): WorkerStatus | undefined {
  return value === "starting" ||
    value === "running" ||
    value === "waitingApproval" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "lost" ||
    value === "closed"
    ? value
    : undefined;
}

function workerFromValue(value: unknown): WorkerToolIdentity | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const id = text(entry.id) ?? text(entry.workerId);
  const name = workerName(entry);
  if (!id || !name) return undefined;
  const assignment = text(entry.assignment);
  const status = workerStatus(entry.status);
  const model = text(entry.model);
  return {
    id,
    name,
    ...(assignment ? { assignment } : {}),
    ...(status ? { status } : {}),
    ...(model ? { model } : {}),
  };
}

function toolData(activity: OrchestrationThreadActivity):
  | {
      readonly payload: Record<string, unknown>;
      readonly data: Record<string, unknown>;
      readonly item?: Record<string, unknown>;
      readonly args?: Record<string, unknown>;
      readonly result?: Record<string, unknown>;
      readonly toolName?: T3WorkerToolName;
      readonly callId?: string;
    }
  | undefined {
  const payload = record(activity.payload);
  const data = record(payload?.data);
  if (!payload || !data) return undefined;
  const item = record(data.item);
  const rawToolName = text(item?.tool) ?? text(data.toolName) ?? text(payload.title);
  const toolName = T3_WORKER_TOOL_NAMES.find(
    (name) => rawToolName === name || rawToolName?.endsWith(`_${name}`),
  );
  if (!toolName || payload.itemType !== "mcp_tool_call") return undefined;
  const args = objectOrJson(item?.arguments ?? data.input ?? item?.input);
  const result = objectOrJson(item?.result ?? data.result);
  const callId = text(data.toolCallId);
  return {
    payload,
    data,
    ...(item ? { item } : {}),
    ...(args ? { args } : {}),
    ...(result ? { result } : {}),
    toolName,
    ...(callId ? { callId } : {}),
  };
}

function lifecycleState(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
  item?: Record<string, unknown>,
): WorkerToolCallState {
  const rawStatus = text(payload.status) ?? text(item?.status);
  if (rawStatus === "failed" || rawStatus === "declined" || activity.tone === "error") {
    return "failed";
  }
  if (rawStatus === "completed" || activity.kind === "tool.completed") return "completed";
  if (
    rawStatus === "inProgress" ||
    rawStatus === "in_progress" ||
    activity.kind === "tool.updated"
  ) {
    return "inProgress";
  }
  return "unknown";
}

function resultWorkers(result: Record<string, unknown> | undefined): WorkerToolIdentity[] {
  if (!result) return [];
  const summary = workerFromValue(result.summary);
  const workers = Array.isArray(result.workers)
    ? result.workers
        .map(workerFromValue)
        .filter((item): item is WorkerToolIdentity => item !== undefined)
    : [];
  return summary ? [summary, ...workers] : workers;
}

function idsFromArgs(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const ids = Array.isArray(args.workerIds)
    ? args.workerIds.map((id) => text(id)).filter((id): id is string => id !== undefined)
    : [];
  const workerId = text(args.workerId);
  if (workerId) ids.push(workerId);
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

function resultSummary(
  toolName: T3WorkerToolName,
  result: Record<string, unknown> | undefined,
  workers: ReadonlyArray<WorkerToolIdentity>,
): string | undefined {
  if (toolName === "worker_list" && workers.length > 0) return `${workers.length} Workers returned`;
  const status = text(result?.status) ?? text(result?.summary && record(result.summary)?.status);
  const reason = text(result?.reason) ?? text(result?.wakeReason);
  if (reason && status) return `${status}, ${reason}`;
  if (reason) return reason;
  if (status) return status;
  return text(result?.message) ?? text(result?.summary);
}

export function parseWorkerToolActivity(
  activity: OrchestrationThreadActivity,
  knownWorkers: ReadonlyMap<string, WorkerToolIdentity> = new Map(),
): WorkerToolCallPresentation | null {
  const parsed = toolData(activity);
  if (!parsed || !parsed.toolName) return null;
  const resultWorkersFound = resultWorkers(parsed.result);
  const ids = idsFromArgs(parsed.args);
  const workers = [
    ...resultWorkersFound,
    ...ids
      .map((id) => knownWorkers.get(id))
      .filter((item): item is WorkerToolIdentity => item !== undefined),
  ].filter((worker, index, all) => all.findIndex((item) => item.id === worker.id) === index);
  const assignment =
    text(parsed.result?.assignment) ??
    text(record(parsed.result?.summary)?.title) ??
    text(parsed.args?.assignment) ??
    text(parsed.args?.title);
  const ended =
    lifecycleState(activity, parsed.payload, parsed.item) === "inProgress"
      ? undefined
      : activity.createdAt;
  const durationMs = number(parsed.item?.durationMs) ?? number(parsed.data.durationMs);
  const summary = resultSummary(parsed.toolName, parsed.result, workers);
  return {
    toolName: parsed.toolName,
    action: ACTIONS[parsed.toolName],
    state: lifecycleState(activity, parsed.payload, parsed.item),
    workerIds: ids.length > 0 ? ids : workers.map((worker) => worker.id),
    workers,
    ...(assignment ? { assignment } : {}),
    ...(summary ? { resultSummary: summary } : {}),
    startedAt: activity.createdAt,
    ...(ended ? { endedAt: ended } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(parsed.callId ? { callId: parsed.callId } : {}),
    rawData: parsed.item ?? parsed.data,
  };
}

function callKey(call: WorkerToolCallPresentation): string {
  // MCP adapters normally provide toolCallId. The fallback deliberately
  // omits the timestamp so a legacy completion can close its in-progress
  // wait even when one side of the record lost the id.
  return call.callId ?? `${call.toolName}:${call.workerIds.join(",")}`;
}

export function deriveWorkerToolCallPresentations(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<WorkerToolCallPresentation> {
  const knownWorkers = new Map<string, WorkerToolIdentity>();
  const calls = new Map<string, WorkerToolCallPresentation>();
  for (const activity of [...activities].toSorted(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
  )) {
    const call = parseWorkerToolActivity(activity, knownWorkers);
    if (!call) continue;
    for (const worker of call.workers) knownWorkers.set(worker.id, worker);
    const key = callKey(call);
    if (call.state === "inProgress") {
      calls.set(key, call);
    } else {
      calls.set(key, call);
    }
  }
  return [...calls.values()];
}

export function deriveActiveWorkerWait(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  nowMs = Date.now(),
): ActiveWorkerWait | null {
  const knownWorkers = new Map<string, WorkerToolIdentity>();
  const active = new Map<string, ActiveWorkerWait>();
  const ordered = [...activities].toSorted((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  for (const activity of ordered) {
    const call = parseWorkerToolActivity(activity);
    if (!call) continue;
    for (const worker of call.workers) knownWorkers.set(worker.id, worker);
  }
  for (const activity of ordered) {
    const parsed = toolData(activity);
    if (!parsed || parsed.toolName !== "worker_wait") continue;
    const call = parseWorkerToolActivity(activity, knownWorkers);
    if (!call) continue;
    const args = parsed.args;
    const key = callKey(call);
    if (call.state === "inProgress") {
      const timeoutMillis = number(args?.timeoutMillis);
      const mode = text(args?.mode);
      const startedAtMs = Date.parse(activity.createdAt);
      const deadlineMs =
        timeoutMillis !== undefined && Number.isFinite(startedAtMs)
          ? startedAtMs + timeoutMillis
          : undefined;
      if (deadlineMs !== undefined && nowMs >= deadlineMs) {
        active.delete(key);
        continue;
      }
      const deadlineAt = deadlineMs !== undefined ? new Date(deadlineMs).toISOString() : undefined;
      const seconds = Number.isFinite(startedAtMs)
        ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000))
        : 0;
      active.set(key, {
        ...call,
        toolName: "worker_wait",
        ...(timeoutMillis !== undefined ? { timeoutMillis } : {}),
        ...(mode ? { mode } : {}),
        wakeReasons: Array.isArray(args?.wakeReasons)
          ? args.wakeReasons.filter((reason): reason is string => typeof reason === "string")
          : [],
        ...(deadlineAt ? { deadlineAt } : {}),
        latestEvent: seconds > 0 ? `Waiting for ${seconds}s` : "Wait started",
      });
    } else {
      active.delete(key);
    }
  }
  return [...active.values()].at(-1) ?? null;
}

export function workerToolDisplayName(call: WorkerToolCallPresentation): string {
  return (
    call.workers.map((worker) => worker.name).join(", ") ||
    (call.workerIds.length > 0
      ? `${call.workerIds.length} Worker${call.workerIds.length === 1 ? "" : "s"}`
      : "Worker")
  );
}

export function workerToolElapsed(call: WorkerToolCallPresentation, nowMs = Date.now()): string {
  const start = Date.parse(call.startedAt);
  const end =
    call.durationMs !== undefined
      ? start + call.durationMs
      : call.endedAt
        ? Date.parse(call.endedAt)
        : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
