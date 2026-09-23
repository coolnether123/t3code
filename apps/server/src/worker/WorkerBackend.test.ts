// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";

import * as ServerConfig from "../config.ts";
import { makeCodexDesktopWorkerBackend, type WorkerBackendStartInput } from "./WorkerBackend.ts";
import {
  createCodexDesktopMailboxLayout,
  publishCodexDesktopBinding,
  publishCodexDesktopResult,
  renewCodexDesktopCoordinatorLease,
} from "./CodexDesktopMailbox.ts";

const makeConfig = (root: string) =>
  ({ baseDir: root, stateDir: root }) as ServerConfig.ServerConfig["Service"];

const fromPromise = <A>(run: () => Promise<A>) => Effect.promise(run).pipe(Effect.orDie);

function observeRequest(layout: ReturnType<typeof createCodexDesktopMailboxLayout>, jobId: string) {
  const target = layout.requestPath(jobId);
  return new Promise<void>((resolve, reject) => {
    const watcher = NodeFS.watch(layout.requestDirectory, () => {
      void NodeFSP.access(target).then(
        () => {
          watcher.close();
          resolve();
        },
        () => {},
      );
    });
    watcher.on("error", (cause) => {
      watcher.close();
      reject(cause);
    });
  });
}

const makeInput = (root: string): WorkerBackendStartInput => ({
  providerThreadId: ThreadId.make("t3-worker-00000000-0000-4000-8000-000000000001"),
  providerInstanceId: ProviderInstanceId.make("codex-test"),
  title: "Desktop test",
  assignment: "Run the desktop assignment.",
  context: {} as WorkerBackendStartInput["context"],
  runtimeMode: "full-access",
  backendPreference: "codex-desktop",
  jobId: "00000000-0000-4000-8000-000000000002",
  requestId: "00000000-0000-4000-8000-000000000002",
  workerId: "00000000-0000-4000-8000-000000000003",
  activationId: "00000000-0000-4000-8000-000000000002",
  cwd: root,
});

describe("Codex Desktop Worker backend", () => {
  it.live("queues a durable request and binds the native child without using ProviderService", () =>
    Effect.gen(function* () {
      const root = yield* fromPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-backend-")),
      );
      const layout = createCodexDesktopMailboxLayout(NodePath.join(root, "codex-desktop-bridge"));
      const now = yield* DateTime.now;
      yield* fromPromise(() =>
        renewCodexDesktopCoordinatorLease(layout, {
          schemaVersion: 1,
          coordinatorThreadId: "00000000-0000-4000-8000-000000000004",
          observedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 1 })),
        }),
      );

      const backend = yield* makeCodexDesktopWorkerBackend().pipe(
        Effect.provide(Layer.succeed(ServerConfig.ServerConfig, makeConfig(root))),
      );
      const input = makeInput(root);
      yield* fromPromise(() => NodeFSP.mkdir(layout.requestDirectory, { recursive: true }));
      const waitingForRequest = observeRequest(layout, input.jobId!);
      const start = yield* Effect.forkChild(backend.start(input));
      yield* fromPromise(() => waitingForRequest);
      const boundAt = DateTime.formatIso(yield* DateTime.now);
      yield* fromPromise(() =>
        publishCodexDesktopBinding(layout, {
          schemaVersion: 1,
          jobId: input.jobId!,
          requestId: input.requestId!,
          operation: "start",
          childThreadId: "00000000-0000-4000-8000-000000000005",
          claimedAt: DateTime.formatIso(now),
          boundAt,
        }),
      );
      const activation = yield* Fiber.join(start);
      expect(activation.pending).toBeUndefined();
      expect(activation.providerThreadId).toBe(input.providerThreadId);
      expect(activation.nativeThreadId).toBe("00000000-0000-4000-8000-000000000005");
    }),
  );

  it.effect("fails explicitly when the native coordinator lease is absent", () =>
    Effect.gen(function* () {
      const root = yield* fromPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-backend-")),
      );
      const backend = yield* makeCodexDesktopWorkerBackend().pipe(
        Effect.provide(Layer.succeed(ServerConfig.ServerConfig, makeConfig(root))),
      );
      const exit = yield* Effect.exit(backend.start(makeInput(root)));
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.live("publishes running then consumes the matching send receipt", () =>
    Effect.gen(function* () {
      const root = yield* fromPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-backend-")),
      );
      const layout = createCodexDesktopMailboxLayout(NodePath.join(root, "codex-desktop-bridge"));
      const now = yield* DateTime.now;
      yield* fromPromise(() =>
        renewCodexDesktopCoordinatorLease(layout, {
          schemaVersion: 1,
          coordinatorThreadId: "00000000-0000-4000-8000-000000000004",
          observedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 1 })),
        }),
      );
      const backend = yield* makeCodexDesktopWorkerBackend().pipe(
        Effect.provide(Layer.succeed(ServerConfig.ServerConfig, makeConfig(root))),
      );
      const input = {
        ...makeInput(root),
        message: "Continue the assignment.",
        jobId: "00000000-0000-4000-8000-000000000006",
        requestId: "00000000-0000-4000-8000-000000000006",
        nativeThreadId: "00000000-0000-4000-8000-000000000005",
      };
      yield* fromPromise(() => NodeFSP.mkdir(layout.requestDirectory, { recursive: true }));
      const waitingForRequest = observeRequest(layout, input.jobId);
      const send = yield* Effect.forkChild(backend.send(input));
      yield* fromPromise(() => waitingForRequest);
      yield* fromPromise(() =>
        publishCodexDesktopResult(layout, {
          schemaVersion: 1,
          jobId: input.jobId,
          requestId: input.requestId,
          operation: "send",
          status: "completed",
          childThreadId: input.nativeThreadId,
          text: "Desktop handoff",
          completedAt: new Date().toISOString(),
        }),
      );
      const activation = yield* Fiber.join(send);
      expect(activation.completionStatus).toBe("completed");
      expect(activation.handoff).toBe("Desktop handoff");
    }),
  );
});
