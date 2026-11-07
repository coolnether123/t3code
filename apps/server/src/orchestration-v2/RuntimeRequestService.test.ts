import { assert, it, vi } from "@effect/vitest";
import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  ProjectId,
  RunId,
  CommandId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.effect.each([
  { source: "Acme", destination: "Beacon", decision: "accept" as const, blocked: true },
  { source: undefined, destination: "Beacon", decision: "accept" as const, blocked: true },
  { source: "Acme", destination: "Acme", decision: "accept" as const, blocked: false },
  { source: undefined, destination: undefined, decision: "accept" as const, blocked: false },
  { source: "Acme", destination: "Beacon", decision: "decline" as const, blocked: false },
  {
    source: "Acme",
    destination: "Beacon",
    decision: "accept" as const,
    blocked: true,
    previousClient: "Acme",
  },
  {
    source: "Acme",
    destination: "Acme",
    decision: "accept" as const,
    blocked: true,
    previousClient: "Beacon",
  },
  {
    source: "Acme",
    destination: undefined,
    decision: "accept" as const,
    blocked: false,
    previousClient: "Acme",
  },
  {
    source: "Acme",
    destination: undefined,
    decision: "accept" as const,
    blocked: true,
    previousClient: "Beacon",
  },
])(
  "fences earlier client approvals before provider execution ($source → $destination, $decision)",
  (test) => {
    const threadId = ThreadId.make("approval-fence-thread");
    const providerSessionId = ProviderSessionId.make("approval-fence-session");
    const requestId = RuntimeRequestId.make("approval-fence-request");
    const nodeId = NodeId.make("approval-fence-node");
    const respond = vi.fn(() => Effect.void);
    const scope = test.source ? { clientName: test.source } : {};
    const layer = RuntimeRequestService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () =>
              Effect.succeedSome({
                sections: test.destination
                  ? [
                      {
                        id: "current",
                        name: test.destination,
                        collapsed: false,
                        scope: { clientName: test.destination },
                      },
                    ]
                  : [],
              } as never),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRuntimeRequest: () =>
              Effect.succeed({
                id: requestId,
                nodeId,
                status: "resolved",
                responseCapability: { type: "live", providerSessionId },
              } as never),
            getThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: threadId,
                  projectId: ProjectId.make("approval-project"),
                  sectionId: test.destination ? "current" : null,
                  ...("previousClient" in test
                    ? {
                        sectionMove: {
                          id: CommandId.make("approval-client-move"),
                          fromSectionId: null,
                          fromSectionName: "Unsorted",
                          toSectionId: test.destination ? "current" : null,
                          toSectionName: test.destination ?? "Unsorted",
                          previousClientScope: { clientName: test.previousClient },
                        },
                      }
                    : {}),
                },
                runs: [
                  {
                    id: RunId.make("approval-source-run"),
                    rootNodeId: nodeId,
                    sectionContext: {
                      sectionId: "old",
                      sectionName: test.source ?? "Unsorted",
                      scope,
                      taskScope: scope,
                      text: "",
                    },
                  },
                ],
                nodes: [],
              } as never),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.succeedSome({ respondToRuntimeRequest: respond } as never),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      const result = yield* Effect.result(
        service.respond({ threadId, providerSessionId, requestId, decision: test.decision }),
      );
      if (test.blocked) {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "client-scope-changed");
        assert.equal(respond.mock.calls.length, 0);
      } else {
        assert.equal(result._tag, "Success");
        assert.equal(respond.mock.calls.length, 1);
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["expired", "resolved"] as const)(
  "responds only to resolved requests and preserves feedback (%s)",
  (status) => {
    const threadId = ThreadId.make("thread-runtime-request-expired");
    const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-expired");
    const requestId = RuntimeRequestId.make("request-expired");
    const respondToRuntimeRequest = vi.fn(
      (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
    );
    const getSession = vi.fn(() =>
      Effect.succeedSome({
        respondToRuntimeRequest,
      } as never),
    );
    const projection = {
      runtimeRequests: [
        {
          id: requestId,
          nodeId: NodeId.make("node-runtime-request-expired"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status,
          responseCapability: {
            type: "live",
            providerSessionId,
          },
          createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
          resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layerTest = RuntimeRequestService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRuntimeRequest: (_threadId, requestId) =>
              Effect.succeed(
                projection.runtimeRequests.find((request) => request.id === requestId),
              ),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: getSession,
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      const response = service.respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "decline",
        feedback: "Use an explicit path.",
      });
      if (status === "resolved") {
        yield* response;
        assert.deepEqual(respondToRuntimeRequest.mock.calls, [
          [
            {
              requestId,
              decision: "decline",
              feedback: "Use an explicit path.",
            },
          ],
        ]);
        return;
      }
      const error = yield* response.pipe(Effect.flip);

      assert.equal(error.reason, "request-not-ready");
      assert.equal(
        error.message,
        `Runtime request ${requestId} on thread ${threadId} is not ready for response execution.`,
      );
      assert.isUndefined(error.cause);
      assert.equal(getSession.mock.calls.length, 0);
      assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  },
);
