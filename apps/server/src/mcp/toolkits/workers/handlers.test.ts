import {
  ApprovalRequestId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WorkerDisabledError,
  WorkerId,
  WorkerOperationError,
  type WorkerDetail,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkerService from "../../../worker/WorkerService.ts";
import { mapWorkerStartRequest, workerHandlers } from "./handlers.ts";

const parentThreadId = ThreadId.make("parent-thread");
const otherParentThreadId = ThreadId.make("other-parent-thread");
const workerId = WorkerId.make("worker-1");
const providerInstanceId = ProviderInstanceId.make("codex-parent");
const now = "2026-08-22T00:00:00.000Z";

const invocation = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability> = new Set(["workers"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: parentThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId,
  workingDirectory: "A:/Dev/Worktrees/project",
  capabilities,
  issuedAt: 1,
});

const detail = (owner: ThreadId = parentThreadId): WorkerDetail => ({
  summary: {
    id: workerId,
    title: "Persistence worker",
    status: "running",
    backend: "codex",
    parentThreadId: owner,
    providerInstanceId,
    model: "gpt-5.6-luna",
    runtimeMode: "full-access",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    unreadMessageCount: 0,
    activationCount: 1,
    resumable: true,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  },
  assignment: "Review persistence.",
  context: { references: [], snippets: [] },
  messages: [],
  activations: [],
  observerReports: [],
});

const makeWorkerService = (
  overrides: Partial<WorkerService.WorkerServiceShape> = {},
): WorkerService.WorkerServiceShape => ({
  start: () => Effect.die("unused start"),
  list: () => Effect.die("unused list"),
  get: () => Effect.die("unused get"),
  send: () => Effect.die("unused send"),
  wait: () => Effect.die("unused wait"),
  observe: () => Effect.die("unused observe"),
  interrupt: () => Effect.die("unused interrupt"),
  close: () => Effect.die("unused close"),
  respondToApproval: () => Effect.die("unused approval"),
  handleProviderEvent: () => Effect.void,
  recover: Effect.void,
  stream: Stream.empty,
  ...overrides,
});

const provideHandler = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    McpInvocationContext.McpInvocationContext | WorkerService.WorkerService
  >,
  scope: McpInvocationContext.McpInvocationScope,
  service: WorkerService.WorkerServiceShape,
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(WorkerService.WorkerService, service),
  );

it("maps parent scope and provider defaults into Worker starts", () => {
  const mapped = mapWorkerStartRequest(invocation(), {
    title: "Persistence",
    assignment: "Review persistence.",
    context: { references: [], snippets: [] },
    modelSelection: {
      instanceId: ProviderInstanceId.make("untrusted-instance"),
      model: "gpt-5.6-luna",
    },
    parentThreadId: otherParentThreadId,
  });

  expect(mapped.parentThreadId).toBe(parentThreadId);
  expect(mapped.providerInstanceId).toBe(providerInstanceId);
  expect(mapped.input.parentThreadId).toBe(parentThreadId);
  expect(mapped.input.modelSelection?.instanceId).toBe(providerInstanceId);
  expect(mapped.input.cwd).toBe("A:/Dev/Worktrees/project");
  expect(Object.hasOwn(mapped.input, "transcript")).toBe(false);
});

it.effect("requires the workers capability before invoking the service", () => {
  const service = makeWorkerService({
    list: () => Effect.die("list must not run"),
  });
  return Effect.gen(function* () {
    const error = yield* provideHandler(
      workerHandlers.worker_list({}),
      invocation(new Set(["preview"])),
      service,
    ).pipe(Effect.flip);
    expect(error).toBeInstanceOf(WorkerDisabledError);
  });
});

it.effect("forces list scope and rejects a Worker owned by another parent", () => {
  let listedParent: ThreadId | undefined;
  const service = makeWorkerService({
    list: (input) => {
      listedParent = input.parentThreadId;
      return Effect.succeed({ workers: [] });
    },
    get: () => Effect.succeed(detail(otherParentThreadId)),
  });
  return Effect.gen(function* () {
    yield* provideHandler(
      workerHandlers.worker_list({ parentThreadId: otherParentThreadId }),
      invocation(),
      service,
    );
    expect(listedParent).toBe(parentThreadId);

    const error = yield* provideHandler(
      workerHandlers.worker_status({ workerId }),
      invocation(),
      service,
    ).pipe(Effect.flip);
    expect(error).toBeInstanceOf(WorkerOperationError);
    expect(error.message).toBe("Worker is not available in this parent scope");
  });
});

it.effect("routes approval responses only after ownership succeeds", () => {
  const requestId = ApprovalRequestId.make("approval-1");
  let response:
    | {
        readonly workerId: WorkerId;
        readonly requestId: ApprovalRequestId;
        readonly decision: "accept" | "decline" | "cancel";
      }
    | undefined;
  const service = makeWorkerService({
    get: () => Effect.succeed(detail()),
    respondToApproval: (input) => {
      response = input;
      return Effect.succeed(detail());
    },
  });
  return Effect.gen(function* () {
    yield* provideHandler(
      workerHandlers.worker_approval_respond({
        workerId,
        requestId,
        decision: "accept",
        note: "Approved for this activation.",
      }),
      invocation(),
      service,
    );
    expect(response).toMatchObject({ workerId, requestId, decision: "accept" });
  });
});
