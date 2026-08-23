import {
  ThreadId,
  ProviderDriverKind,
  WorkerOperationError,
  type ModelSelection,
  type ProviderApprovalPolicy,
  type ProviderSandboxMode,
  type ProviderInstanceId,
  type ProviderTurnStartResult,
  type RuntimeMode,
  type WorkerContextPackage,
  type WorkerPermissionMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProviderService from "../provider/Services/ProviderService.ts";
import { buildWorkerAssignmentPrompt } from "./WorkerContext.ts";
export {
  WORKER_PROVIDER_THREAD_PREFIX,
  isWorkerLinkedProviderThreadId,
} from "./WorkerThreadBoundary.ts";

export interface WorkerBackendStartInput {
  readonly providerThreadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly title: string;
  readonly assignment: string;
  readonly context: WorkerContextPackage;
  readonly instructions?: string | undefined;
  readonly cwd?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: ProviderApprovalPolicy | undefined;
  readonly sandboxMode?: ProviderSandboxMode | undefined;
}

export interface WorkerBackendActivation {
  readonly providerThreadId: ThreadId;
  readonly providerTurnId: ProviderTurnStartResult["turnId"];
  readonly resumeCursor?: unknown;
}

export interface WorkerBackendSendInput {
  readonly providerThreadId: ThreadId;
  readonly message: string;
  readonly context?: WorkerContextPackage | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly providerInstanceId: WorkerBackendStartInput["providerInstanceId"];
  readonly cwd?: string | undefined;
  readonly title: string;
  readonly approvalPolicy?: ProviderApprovalPolicy | undefined;
  readonly sandboxMode?: ProviderSandboxMode | undefined;
}

export interface WorkerBackendShape {
  readonly start: (
    input: WorkerBackendStartInput,
  ) => Effect.Effect<WorkerBackendActivation, WorkerOperationError>;
  readonly send: (
    input: WorkerBackendSendInput,
  ) => Effect.Effect<WorkerBackendActivation, WorkerOperationError>;
  readonly interrupt: (input: {
    readonly providerThreadId: ThreadId;
    readonly providerTurnId?: ProviderTurnStartResult["turnId"] | undefined;
  }) => Effect.Effect<void, WorkerOperationError>;
  readonly stop: (providerThreadId: ThreadId) => Effect.Effect<void, WorkerOperationError>;
  readonly respondToApproval: (input: {
    readonly providerThreadId: ThreadId;
    readonly requestId: import("@t3tools/contracts").ApprovalRequestId;
    readonly decision: "accept" | "decline" | "cancel";
  }) => Effect.Effect<void, WorkerOperationError>;
  readonly hasLiveSession: (
    providerThreadId: ThreadId,
  ) => Effect.Effect<boolean, WorkerOperationError>;
}

export class WorkerBackend extends Context.Service<WorkerBackend, WorkerBackendShape>()(
  "t3/worker/WorkerBackend",
) {}

const operationError = (operation: string, cause: unknown) =>
  new WorkerOperationError({ operation, message: `${operation} failed`, cause });

const isWorkerOperationError = Schema.is(WorkerOperationError);
const codexDriverKind = ProviderDriverKind.make("codex");

const runtimeModeFromPermission = (
  mode: WorkerPermissionMode | undefined,
): RuntimeMode | undefined => {
  switch (mode) {
    case "readOnly":
      return "approval-required";
    case "workspaceWrite":
      return "auto-accept-edits";
    case "fullAccess":
      return "full-access";
    default:
      return undefined;
  }
};

export const makeCodexLinkedWorkerBackend = Effect.fn("makeCodexLinkedWorkerBackend")(function* () {
  const provider = yield* ProviderService.ProviderService;

  const ensureCodex = Effect.fn("WorkerBackend.ensureCodex")(function* (
    instanceId: WorkerBackendStartInput["providerInstanceId"],
  ) {
    const info = yield* provider.getInstanceInfo(instanceId);
    if (info.driverKind !== "codex") {
      return yield* new WorkerOperationError({
        operation: "worker.codexBackend",
        message: `Provider instance '${instanceId}' is '${info.driverKind}', not codex`,
      });
    }
    return info;
  });

  const start: WorkerBackendShape["start"] = (input) =>
    Effect.gen(function* () {
      yield* ensureCodex(input.providerInstanceId);
      const session = yield* provider.startSession(input.providerThreadId, {
        threadId: input.providerThreadId,
        provider: codexDriverKind,
        providerInstanceId: input.providerInstanceId,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        title: input.title,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
        ...(input.sandboxMode === undefined ? {} : { sandboxMode: input.sandboxMode }),
        runtimeMode: input.runtimeMode,
      });
      const turn = yield* provider.sendTurn({
        threadId: input.providerThreadId,
        input: buildWorkerAssignmentPrompt(input),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      });
      return {
        providerThreadId: session.threadId,
        providerTurnId: turn.turnId,
        ...(turn.resumeCursor === undefined ? {} : { resumeCursor: turn.resumeCursor }),
      };
    }).pipe(
      Effect.mapError((cause) =>
        isWorkerOperationError(cause) ? cause : operationError("worker.start", cause),
      ),
    );

  const send: WorkerBackendShape["send"] = (input) =>
    Effect.gen(function* () {
      yield* ensureCodex(input.providerInstanceId);
      const turn = yield* provider.sendTurn({
        threadId: input.providerThreadId,
        input: [
          input.message.trim(),
          input.context === undefined
            ? ""
            : buildWorkerAssignmentPrompt({ assignment: input.message, context: input.context }),
        ]
          .filter(Boolean)
          .join("\n\n"),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      });
      return {
        providerThreadId: input.providerThreadId,
        providerTurnId: turn.turnId,
        ...(turn.resumeCursor === undefined ? {} : { resumeCursor: turn.resumeCursor }),
      };
    }).pipe(
      Effect.mapError((cause) =>
        isWorkerOperationError(cause) ? cause : operationError("worker.send", cause),
      ),
    );

  const interrupt: WorkerBackendShape["interrupt"] = (input) =>
    provider
      .interruptTurn({
        threadId: input.providerThreadId,
        ...(input.providerTurnId === undefined ? {} : { turnId: input.providerTurnId }),
      })
      .pipe(Effect.mapError((cause) => operationError("worker.interrupt", cause)));

  const stop: WorkerBackendShape["stop"] = (providerThreadId) =>
    provider
      .stopSession({ threadId: providerThreadId })
      .pipe(Effect.mapError((cause) => operationError("worker.close", cause)));

  const respondToApproval: WorkerBackendShape["respondToApproval"] = (input) =>
    provider
      .respondToRequest({
        threadId: input.providerThreadId,
        requestId: input.requestId,
        decision: input.decision,
      })
      .pipe(Effect.mapError((cause) => operationError("worker.approvalRespond", cause)));

  const hasLiveSession: WorkerBackendShape["hasLiveSession"] = (providerThreadId) =>
    provider.listSessions().pipe(
      Effect.map((sessions) => sessions.some((session) => session.threadId === providerThreadId)),
      Effect.mapError((cause) => operationError("worker.recover", cause)),
    );

  return {
    start,
    send,
    interrupt,
    stop,
    respondToApproval,
    hasLiveSession,
  } satisfies WorkerBackendShape;
});

export const CodexLinkedWorkerBackendLive = Layer.effect(
  WorkerBackend,
  makeCodexLinkedWorkerBackend(),
);

export { runtimeModeFromPermission };
