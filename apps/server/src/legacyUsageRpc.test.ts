import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, LegacyUsageRpcGroup, WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as UsageService from "./usage/UsageService.ts";
import { WS_RPC_SERVER_OPTIONS } from "./ws.ts";

const routes = Layer.unwrap(
  Effect.gen(function* () {
    const usage = yield* UsageService.UsageService;
    const websocket = yield* RpcServer.toHttpEffectWebsocket(
      LegacyUsageRpcGroup,
      WS_RPC_SERVER_OPTIONS,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          LegacyUsageRpcGroup.toLayer({
            [WS_METHODS.serverGetUsageSummary]: (input) => usage.readSummary(input),
            [WS_METHODS.serverGetUsageReport]: (input) => usage.readReport(input),
          }),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
          RpcSerialization.layerJson,
        ),
      ),
    );
    return HttpRouter.add("GET", "/ws", websocket);
  }),
).pipe(Layer.provide(UsageService.layerTest));

it.effect("keeps legacy usage Request/Exit frames and Ping/Pong over a real websocket", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(NodeServices.layer),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
    const replies = Promise.withResolvers<void>();
    const received: Array<Record<string, unknown>> = [];
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(`${origin}/ws`);
        socket.addEventListener("error", () =>
          replies.reject(new Error("Usage websocket failed.")),
        );
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
          received.push(frame);
          if (
            received.some((frame) => frame._tag === "Pong") &&
            received.filter((frame) => frame._tag === "Exit").length === 2
          )
            replies.resolve();
        });
        socket.addEventListener("open", () => {
          const usageWindow = {
            sinceDay: "2026-10-01",
            untilDay: "2026-10-19",
            timeZone: "America/Chicago",
          };
          socket.send(JSON.stringify({ _tag: "Ping" }));
          socket.send(
            JSON.stringify({
              _tag: "Request",
              id: "1",
              tag: WS_METHODS.serverGetUsageSummary,
              payload: {
                ...usageWindow,
                clientContractVersion: 7,
                resolution: "day",
                groupBy: "model",
                includeQuotaHistory: false,
                includeRepeatedInput: false,
              },
              headers: [],
            }),
          );
          socket.send(
            JSON.stringify({
              _tag: "Request",
              id: "2",
              tag: WS_METHODS.serverGetUsageReport,
              payload: { ...usageWindow, mode: "overview" },
              headers: [],
            }),
          );
        });
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    yield* Effect.promise(() => replies.promise);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(received).toContainEqual({ _tag: "Pong" });
    expect(received.find((frame) => frame.requestId === "1")).toMatchObject({
      _tag: "Exit",
      requestId: "1",
      exit: { _tag: "Success", value: { contractVersion: 7 } },
    });
    expect(received.find((frame) => frame.requestId === "2")).toMatchObject({
      _tag: "Exit",
      requestId: "2",
      exit: { _tag: "Success", value: { mode: "overview" } },
    });
  }).pipe(Effect.scoped),
);
