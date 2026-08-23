import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpServer } from "effect/unstable/ai";

import * as WorkerService from "../worker/WorkerService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const workerService = WorkerService.WorkerService.of({
  start: () => Effect.die("unused start"),
  list: () => Effect.die("unused list"),
  get: () => Effect.die("unused get"),
  send: () => Effect.die("unused send"),
  wait: () => Effect.die("unused wait"),
  observe: () => Effect.die("unused observe"),
  interrupt: () => Effect.die("unused interrupt"),
  close: () => Effect.die("unused close"),
  respondToApproval: () => Effect.die("unused approval"),
  reconcileParentAfterRewind: () => Effect.die("unused reconciliation"),
  handleProviderEvent: () => Effect.void,
  recover: Effect.void,
  stream: Stream.empty,
});

const makeCatalogLayer = (enableT3Workers: boolean) =>
  McpHttpServer.makeToolkitRegistrationLive(enableT3Workers).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provide(Layer.succeed(WorkerService.WorkerService, workerService)),
  );

const workerToolNames = [
  "worker_start",
  "worker_list",
  "worker_wait",
  "worker_status",
  "worker_observe",
  "worker_send",
  "worker_interrupt",
  "worker_close",
  "worker_approval_respond",
] as const;

it.effect("omits Worker tools when startup registration is disabled", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const names = server.tools.map(({ tool }) => tool.name);
    expect(names.some((name) => name.startsWith("worker_"))).toBe(false);
    expect(names).toContain("preview_status");
  }).pipe(Effect.provide(makeCatalogLayer(false))),
);

it.effect("advertises exactly nine Worker tools when startup registration is enabled", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const names = server.tools
      .map(({ tool }) => tool.name)
      .filter((name) => name.startsWith("worker_"));
    expect(names).toEqual(workerToolNames);
    expect(server.tools.map(({ tool }) => tool.name)).toContain("preview_status");
  }).pipe(Effect.provide(makeCatalogLayer(true))),
);
