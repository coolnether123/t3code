/**
 * Provider-neutral contracts for T3-managed Workers.
 *
 * A Worker is a persistent T3 identity. Each execution is an Activation, and
 * the assignment/context package is kept separate from the parent thread's
 * transcript. Providers may implement the backend differently, but these
 * records are the stable boundary used by MCP, WebSocket clients, and the
 * Worker inbox.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ApprovalRequestId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  ProviderApprovalPolicy,
  ProviderSandboxMode,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const WorkerEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const WorkerId = WorkerEntityId("WorkerId");
export type WorkerId = typeof WorkerId.Type;

export const WorkerActivationId = WorkerEntityId("WorkerActivationId");
export type WorkerActivationId = typeof WorkerActivationId.Type;

export const WorkerMessageId = WorkerEntityId("WorkerMessageId");
export type WorkerMessageId = typeof WorkerMessageId.Type;

export const WorkerWaitLeaseId = WorkerEntityId("WorkerWaitLeaseId");
export type WorkerWaitLeaseId = typeof WorkerWaitLeaseId.Type;

export const WorkerObserverReportId = WorkerEntityId("WorkerObserverReportId");
export type WorkerObserverReportId = typeof WorkerObserverReportId.Type;

/** The backend identifier is open so the contract does not encode one provider. */
export const WorkerBackendKind = TrimmedNonEmptyString;
export type WorkerBackendKind = typeof WorkerBackendKind.Type;

export const WorkerStatus = Schema.Literals([
  "starting",
  "running",
  "waitingApproval",
  "completed",
  "failed",
  "interrupted",
  "lost",
  "closed",
]);
export type WorkerStatus = typeof WorkerStatus.Type;

export const WorkerActivationStatus = Schema.Literals([
  "starting",
  "running",
  "waitingApproval",
  "completed",
  "failed",
  "interrupted",
  "lost",
]);
export type WorkerActivationStatus = typeof WorkerActivationStatus.Type;

export const WorkerPermissionMode = Schema.Literals(["readOnly", "workspaceWrite", "fullAccess"]);
export type WorkerPermissionMode = typeof WorkerPermissionMode.Type;

export const WorkerMessageAuthor = Schema.Literals(["parent", "worker", "observer", "system"]);
export type WorkerMessageAuthor = typeof WorkerMessageAuthor.Type;

export const WorkerMessageKind = Schema.Literals([
  "assignment",
  "followUp",
  "handoff",
  "observerReport",
  "approvalRequest",
  "approvalDecision",
  "lifecycle",
  "error",
  "interrupt",
  "close",
]);
export type WorkerMessageKind = typeof WorkerMessageKind.Type;

export const WorkerWakeReason = Schema.Literals([
  "message",
  "statusChanged",
  "approvalRequested",
  "completed",
  "failed",
  "interrupted",
  "closed",
  "lost",
  "expired",
  "userInput",
]);
export type WorkerWakeReason = typeof WorkerWakeReason.Type;

export const WorkerApprovalDecision = Schema.Literals(["accept", "decline", "cancel"]);
export type WorkerApprovalDecision = typeof WorkerApprovalDecision.Type;

export const WorkerWaitLeaseStatus = Schema.Literals(["waiting", "woken", "expired", "cancelled"]);
export type WorkerWaitLeaseStatus = typeof WorkerWaitLeaseStatus.Type;

/** A file, symbol, or bounded excerpt explicitly selected for the worker. */
export const WorkerContextReference = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineStart: Schema.optionalKey(PositiveInt),
  lineEnd: Schema.optionalKey(PositiveInt),
  symbol: Schema.optionalKey(TrimmedNonEmptyString),
  excerpt: Schema.optionalKey(Schema.String),
});
export type WorkerContextReference = typeof WorkerContextReference.Type;

/**
 * Explicit context sent to a Worker. This deliberately has no transcript or
 * opaque parent-history field: callers must select the paths and snippets.
 */
export const WorkerContextPackage = Schema.Struct({
  note: Schema.optionalKey(Schema.String),
  references: Schema.Array(WorkerContextReference).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  snippets: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  maxCharacters: Schema.optionalKey(PositiveInt),
});
export type WorkerContextPackage = typeof WorkerContextPackage.Type;

export const WorkerTokenUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  cachedInputTokens: Schema.optionalKey(NonNegativeInt),
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  reasoningOutputTokens: Schema.optionalKey(NonNegativeInt),
  totalTokens: NonNegativeInt,
  toolUses: Schema.optionalKey(NonNegativeInt),
  durationMillis: Schema.optionalKey(NonNegativeInt),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  reasoningEffort: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkerTokenUsage = typeof WorkerTokenUsage.Type;

/** Usage is persisted per activation and rolled up on the Worker summary. */
export const WorkerUsage = WorkerTokenUsage;
export type WorkerUsage = WorkerTokenUsage;

export const WorkerMessage = Schema.Struct({
  id: WorkerMessageId,
  workerId: WorkerId,
  activationId: Schema.optionalKey(WorkerActivationId),
  author: WorkerMessageAuthor,
  kind: WorkerMessageKind,
  body: Schema.String,
  createdAt: IsoDateTime,
  readAt: Schema.optionalKey(IsoDateTime),
});
export type WorkerMessage = typeof WorkerMessage.Type;

export const WorkerActivation = Schema.Struct({
  id: WorkerActivationId,
  workerId: WorkerId,
  status: WorkerActivationStatus,
  providerInstanceId: ProviderInstanceId,
  providerThreadId: ThreadId,
  providerTurnId: Schema.optionalKey(TurnId),
  parentTurnId: Schema.optionalKey(TurnId),
  assignment: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(WorkerContextPackage),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  permissionMode: Schema.optionalKey(WorkerPermissionMode),
  startedAt: IsoDateTime,
  finishedAt: Schema.optionalKey(IsoDateTime),
  lastActivityAt: IsoDateTime,
  usageBaseline: WorkerTokenUsage,
  usageDelta: WorkerTokenUsage,
  latestUsage: Schema.optionalKey(WorkerTokenUsage),
  handoff: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type WorkerActivation = typeof WorkerActivation.Type;

export const WorkerApprovalRequest = Schema.Struct({
  requestId: ApprovalRequestId,
  workerId: WorkerId,
  activationId: WorkerActivationId,
  kind: TrimmedNonEmptyString,
  summary: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  requestedAt: IsoDateTime,
  status: Schema.optionalKey(Schema.Literals(["pending", "resolved", "stale"])),
  resolvedAt: Schema.optionalKey(IsoDateTime),
  decision: Schema.optionalKey(WorkerApprovalDecision),
});
export type WorkerApprovalRequest = typeof WorkerApprovalRequest.Type;

export const WorkerObserverReport = Schema.Struct({
  id: WorkerObserverReportId,
  workerId: WorkerId,
  activationId: Schema.optionalKey(WorkerActivationId),
  model: TrimmedNonEmptyString,
  report: Schema.String,
  progress: Schema.optionalKey(Schema.String),
  blockers: Schema.Array(Schema.String),
  nextAction: Schema.optionalKey(Schema.String),
  appearsBlocked: Schema.optionalKey(Schema.Boolean),
  safeToLeaveRunning: Schema.optionalKey(Schema.Boolean),
  files: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  verification: Schema.optionalKey(Schema.Array(Schema.String)),
  parentDecision: Schema.optionalKey(Schema.String),
  observedStatus: WorkerStatus,
  readOnly: Schema.Literal(true),
  generatedAt: IsoDateTime,
});
export type WorkerObserverReport = typeof WorkerObserverReport.Type;

export const WorkerSummary = Schema.Struct({
  id: WorkerId,
  title: TrimmedNonEmptyString,
  status: WorkerStatus,
  backend: WorkerBackendKind,
  parentThreadId: ThreadId,
  projectId: Schema.optionalKey(ProjectId),
  environmentId: Schema.optionalKey(EnvironmentId),
  providerInstanceId: ProviderInstanceId,
  providerThreadId: Schema.optionalKey(ThreadId),
  model: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  workingDirectory: Schema.optionalKey(TrimmedNonEmptyString),
  permissionMode: Schema.optionalKey(WorkerPermissionMode),
  reasoningEffort: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.optionalKey(IsoDateTime),
  activeActivationId: Schema.optionalKey(WorkerActivationId),
  lastActivityAt: IsoDateTime,
  lastDirectMessageAt: Schema.optionalKey(IsoDateTime),
  unreadMessageCount: NonNegativeInt,
  activationCount: NonNegativeInt,
  resumable: Schema.Boolean,
  usage: WorkerTokenUsage,
  elapsedMs: Schema.optionalKey(NonNegativeInt),
  latestDirectMessage: Schema.optionalKey(WorkerMessage),
  hasPendingApproval: Schema.optionalKey(Schema.Boolean),
  hasUnreadEvents: Schema.optionalKey(Schema.Boolean),
  latestObserverReport: Schema.optionalKey(WorkerObserverReport),
});
export type WorkerSummary = typeof WorkerSummary.Type;

export const WorkerDetail = Schema.Struct({
  summary: WorkerSummary,
  assignment: Schema.String,
  context: WorkerContextPackage,
  instructions: Schema.optionalKey(Schema.String),
  messages: Schema.Array(WorkerMessage),
  activations: Schema.Array(WorkerActivation),
  pendingApproval: Schema.optionalKey(WorkerApprovalRequest),
  observerReports: Schema.Array(WorkerObserverReport),
});
export type WorkerDetail = typeof WorkerDetail.Type;

export const WorkerStartInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  assignment: Schema.String,
  context: WorkerContextPackage,
  instructions: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(ModelSelection),
  backendPreference: Schema.optionalKey(WorkerBackendKind),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  permissionMode: Schema.optionalKey(WorkerPermissionMode),
  approvalPolicy: Schema.optionalKey(ProviderApprovalPolicy),
  sandboxMode: Schema.optionalKey(ProviderSandboxMode),
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
  parentThreadId: Schema.optionalKey(ThreadId),
});
export type WorkerStartInput = typeof WorkerStartInput.Type;

export const WorkerSendInput = Schema.Struct({
  workerId: WorkerId,
  message: Schema.String,
  context: Schema.optionalKey(WorkerContextPackage),
});
export type WorkerSendInput = typeof WorkerSendInput.Type;

export const WorkerListInput = Schema.Struct({
  parentThreadId: Schema.optionalKey(ThreadId),
  includeClosed: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
  cursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkerListInput = typeof WorkerListInput.Type;

export const WorkerListResult = Schema.Struct({
  workers: Schema.Array(WorkerSummary),
  nextCursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkerListResult = typeof WorkerListResult.Type;

export const WorkerGetInput = Schema.Struct({ workerId: WorkerId });
export type WorkerGetInput = typeof WorkerGetInput.Type;

export const WorkerWaitInput = Schema.Struct({
  workerIds: Schema.Array(WorkerId),
  timeoutMillis: PositiveInt,
  until: Schema.optionalKey(Schema.Array(WorkerStatus)),
  mode: Schema.optionalKey(Schema.Literals(["anyRelevantEvent", "allSelectedSettled"])),
  wakeReasons: Schema.optionalKey(Schema.Array(WorkerWakeReason)),
  includeMessages: Schema.optionalKey(Schema.Boolean),
});
export type WorkerWaitInput = typeof WorkerWaitInput.Type;

export const WorkerWaitLease = Schema.Struct({
  leaseId: WorkerWaitLeaseId,
  parentThreadId: Schema.optionalKey(ThreadId),
  workerIds: Schema.Array(WorkerId),
  deadlineAt: IsoDateTime,
  status: WorkerWaitLeaseStatus,
  wakeReason: Schema.optionalKey(WorkerWakeReason),
  createdAt: IsoDateTime,
  completedAt: Schema.optionalKey(IsoDateTime),
});
export type WorkerWaitLease = typeof WorkerWaitLease.Type;

export const WorkerWakeEvent = Schema.Struct({
  workerId: WorkerId,
  activationId: Schema.optionalKey(WorkerActivationId),
  reason: WorkerWakeReason,
  status: WorkerStatus,
  occurredAt: IsoDateTime,
  messageId: Schema.optionalKey(WorkerMessageId),
});
export type WorkerWakeEvent = typeof WorkerWakeEvent.Type;

export const WorkerWaitResult = Schema.Struct({
  leaseId: WorkerWaitLeaseId,
  status: Schema.Literals(["woken", "expired"]),
  reason: WorkerWakeReason,
  events: Schema.Array(WorkerWakeEvent),
  workers: Schema.Array(WorkerSummary),
  lease: Schema.optionalKey(WorkerWaitLease),
  completedAt: IsoDateTime,
});
export type WorkerWaitResult = typeof WorkerWaitResult.Type;

export const WorkerObserveInput = Schema.Struct({
  workerId: WorkerId,
  focus: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type WorkerObserveInput = typeof WorkerObserveInput.Type;

export const WorkerInterruptInput = Schema.Struct({
  workerId: WorkerId,
  force: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(Schema.String),
});
export type WorkerInterruptInput = typeof WorkerInterruptInput.Type;

export const WorkerCloseInput = Schema.Struct({ workerId: WorkerId });
export type WorkerCloseInput = typeof WorkerCloseInput.Type;

export const WorkerApprovalResponseInput = Schema.Struct({
  workerId: WorkerId,
  requestId: ApprovalRequestId,
  decision: WorkerApprovalDecision,
  note: Schema.optionalKey(Schema.String),
});
export type WorkerApprovalResponseInput = typeof WorkerApprovalResponseInput.Type;

export const WorkerSubscribeInput = Schema.Struct({
  parentThreadId: Schema.optionalKey(ThreadId),
  includeClosed: Schema.optionalKey(Schema.Boolean),
});
export type WorkerSubscribeInput = typeof WorkerSubscribeInput.Type;

export const WorkerEvent = Schema.Struct({
  sequence: NonNegativeInt,
  workerId: WorkerId,
  type: Schema.Literals([
    "created",
    "updated",
    "message",
    "approvalRequested",
    "approvalResolved",
    "observerReport",
    "deleted",
  ]),
  occurredAt: IsoDateTime,
  summary: WorkerSummary,
  message: Schema.optionalKey(WorkerMessage),
  approval: Schema.optionalKey(WorkerApprovalRequest),
  observerReport: Schema.optionalKey(WorkerObserverReport),
});
export type WorkerEvent = typeof WorkerEvent.Type;

/** MCP uses the same validated payloads as WebSocket callers. These named
 * aliases make the tool surface discoverable without creating a second wire
 * model that could drift from the server API. */
export const WorkerMcpStartInput = WorkerStartInput;
export type WorkerMcpStartInput = WorkerStartInput;
export const WorkerMcpListInput = WorkerListInput;
export type WorkerMcpListInput = WorkerListInput;
export const WorkerMcpGetInput = WorkerGetInput;
export type WorkerMcpGetInput = WorkerGetInput;
export const WorkerMcpSendInput = WorkerSendInput;
export type WorkerMcpSendInput = WorkerSendInput;
export const WorkerMcpWaitInput = WorkerWaitInput;
export type WorkerMcpWaitInput = WorkerWaitInput;
export const WorkerMcpObserveInput = WorkerObserveInput;
export type WorkerMcpObserveInput = WorkerObserveInput;
export const WorkerMcpApprovalResponseInput = WorkerApprovalResponseInput;
export type WorkerMcpApprovalResponseInput = WorkerApprovalResponseInput;
export const WorkerMcpInterruptInput = WorkerInterruptInput;
export type WorkerMcpInterruptInput = WorkerInterruptInput;
export const WorkerMcpCloseInput = WorkerCloseInput;
export type WorkerMcpCloseInput = WorkerCloseInput;
export const WorkerMcpListResult = WorkerListResult;
export type WorkerMcpListResult = WorkerListResult;
export const WorkerMcpGetResult = WorkerDetail;
export type WorkerMcpGetResult = WorkerDetail;
export const WorkerMcpStartResult = WorkerDetail;
export type WorkerMcpStartResult = WorkerDetail;
export const WorkerMcpSendResult = WorkerDetail;
export type WorkerMcpSendResult = WorkerDetail;
export const WorkerMcpObserveResult = WorkerObserverReport;
export type WorkerMcpObserveResult = WorkerObserverReport;
export const WorkerMcpInterruptResult = WorkerDetail;
export type WorkerMcpInterruptResult = WorkerDetail;
export const WorkerMcpCloseResult = WorkerDetail;
export type WorkerMcpCloseResult = WorkerDetail;
export const WorkerMcpApprovalResponseResult = WorkerDetail;
export type WorkerMcpApprovalResponseResult = WorkerDetail;
export const WorkerMcpWaitResult = WorkerWaitResult;
export type WorkerMcpWaitResult = WorkerWaitResult;

export class WorkerNotFoundError extends Schema.TaggedErrorClass<WorkerNotFoundError>()(
  "WorkerNotFoundError",
  { workerId: WorkerId },
) {}

export class WorkerDisabledError extends Schema.TaggedErrorClass<WorkerDisabledError>()(
  "WorkerDisabledError",
  {},
) {}

export class WorkerOperationError extends Schema.TaggedErrorClass<WorkerOperationError>()(
  "WorkerOperationError",
  {
    operation: TrimmedNonEmptyString,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export const WorkerError = Schema.Union([
  WorkerNotFoundError,
  WorkerDisabledError,
  WorkerOperationError,
]);
export type WorkerError = typeof WorkerError.Type;
