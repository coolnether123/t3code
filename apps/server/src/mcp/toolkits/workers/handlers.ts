import {
  type WorkerDetail,
  type WorkerId,
  WorkerOperationError,
  type WorkerStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkerService from "../../../worker/WorkerService.ts";
import { WorkerToolkit } from "./tools.ts";

export const mapWorkerStartRequest = (
  scope: McpInvocationContext.McpInvocationScope,
  input: WorkerStartInput,
): WorkerService.WorkerStartRequest => {
  const modelSelection =
    input.modelSelection === undefined
      ? undefined
      : { ...input.modelSelection, instanceId: scope.providerInstanceId };
  return {
    parentThreadId: scope.threadId,
    providerInstanceId: scope.providerInstanceId,
    input: {
      ...input,
      parentThreadId: scope.threadId,
      ...(input.cwd === undefined && scope.workingDirectory !== undefined
        ? { cwd: scope.workingDirectory }
        : {}),
      ...(modelSelection === undefined ? {} : { modelSelection }),
    },
  };
};

const ownershipError = (operation: string) =>
  new WorkerOperationError({
    operation,
    message: "Worker is not available in this parent scope",
  });

const requireOwnedWorker = (
  workers: WorkerService.WorkerServiceShape,
  scope: McpInvocationContext.McpInvocationScope,
  workerId: WorkerId,
  operation: string,
): Effect.Effect<WorkerDetail, WorkerOperationError> =>
  workers
    .get(workerId)
    .pipe(
      Effect.flatMap((detail) =>
        detail.summary.parentThreadId === scope.threadId
          ? Effect.succeed(detail)
          : ownershipError(operation),
      ),
    );

const withWorkerScope = Effect.fn("WorkerToolkit.withScope")(function* <A>(
  use: (
    workers: WorkerService.WorkerServiceShape,
    scope: McpInvocationContext.McpInvocationScope,
  ) => Effect.Effect<A, WorkerOperationError>,
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("workers");
  const workers = yield* WorkerService.WorkerService;
  return yield* use(workers, scope);
});

export const workerHandlers = {
  worker_start: (input) =>
    withWorkerScope((workers, scope) => workers.start(mapWorkerStartRequest(scope, input))),
  worker_list: (input) =>
    withWorkerScope((workers, scope) => workers.list({ ...input, parentThreadId: scope.threadId })),
  worker_wait: (input) =>
    withWorkerScope((workers, scope) =>
      Effect.forEach(input.workerIds, (workerId) =>
        requireOwnedWorker(workers, scope, workerId, "worker.wait"),
      ).pipe(Effect.andThen(workers.wait(input))),
    ),
  worker_status: (input) =>
    withWorkerScope((workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.status"),
    ),
  worker_observe: (input) =>
    withWorkerScope((workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.observe").pipe(
        Effect.andThen(workers.observe(input)),
      ),
    ),
  worker_send: (input) =>
    withWorkerScope((workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.send").pipe(
        Effect.andThen(workers.send(input)),
      ),
    ),
  worker_interrupt: (input) =>
    withWorkerScope((workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.interrupt").pipe(
        Effect.andThen(workers.interrupt(input)),
      ),
    ),
  worker_close: (input) =>
    withWorkerScope((workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.close").pipe(
        Effect.andThen(workers.close(input.workerId)),
      ),
    ),
  worker_approval_respond: (input) =>
    withWorkerScope((workers, scope) =>
      requireOwnedWorker(workers, scope, input.workerId, "worker.approvalRespond").pipe(
        Effect.andThen(workers.respondToApproval(input)),
      ),
    ),
} satisfies Parameters<typeof WorkerToolkit.toLayer>[0];

export const WorkerToolkitHandlersLive = WorkerToolkit.toLayer(workerHandlers);
