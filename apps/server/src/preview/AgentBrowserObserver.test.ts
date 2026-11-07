import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { agentBrowserTabId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as AgentBrowserObserver from "./AgentBrowserObserver.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const lease = {
  leaseId: "lease",
  threadId: "thread",
  workerId: "worker",
  profileId: "Agent",
  pages: [{ pageId: "page", title: "Example", url: "https://example.com" }],
  viewOnly: true,
};

const fixture = Effect.fn("AgentBrowserObserver.test.fixture")(function* (
  owners: ReadonlyMap<string, ThreadId> = new Map(),
) {
  const chunks = yield* Queue.make<Uint8Array>();
  const disconnected = yield* Deferred.make<void>();
  const requests: Array<{ method: string; url: string }> = [];
  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push({ method: request.method, url: url.href });
      const response = HttpClientResponse.fromWeb(
        request,
        Response.json({ version: 1, machine: "Elora", leases: [lease] }),
      );
      if (url.pathname !== "/observer/stream") return response;
      return Object.defineProperty(response, "stream", {
        value: Stream.fromQueue(chunks).pipe(
          Stream.ensuring(Deferred.succeed(disconnected, undefined)),
        ),
      });
    }),
  );
  const context = yield* Layer.build(
    AgentBrowserObserver.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Layer.provide(
        FileSystem.layerNoop({ readFileString: () => Effect.succeed("fixture-only-token") }),
      ),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2, {
          getNativeThreadOwners: () => Effect.succeed(owners),
        }),
      ),
      Layer.provide(NodeServices.layer),
    ),
  );
  const observer = Context.get(context, AgentBrowserObserver.AgentBrowserObserver);
  const send = (event: string, data: unknown) =>
    Queue.offer(
      chunks,
      new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  return { observer, requests, disconnected, send };
});

it.effect("binds page streams to their exact owning thread and never sends input", () =>
  Effect.gen(function* () {
    const { observer, requests, send, disconnected } = yield* fixture();
    expect((yield* observer.list("other-thread")).leases).toEqual([]);
    const missing = yield* observer
      .attachViewer({ threadId: "other-thread", tabId: agentBrowserTabId("lease", "page") })
      .pipe(Effect.flip);
    expect(missing._tag).toBe("ServerBrowserTabNotFoundError");
    expect(requests.every(({ url }) => !url.includes("/observer/stream"))).toBe(true);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const viewer = yield* observer.attachViewer({
          threadId: "thread",
          tabId: agentBrowserTabId("lease", "page"),
        });
        expect(yield* Queue.take(viewer.output)).toMatchObject({
          _tag: "control",
          canOperate: false,
        });
        yield* viewer.input({ type: "takeControl" });
        yield* viewer.input({ type: "navigate", url: "https://invalid.test" });
        yield* viewer.input({ type: "resize", width: 200, height: 100 });
        yield* viewer.input({ type: "text", text: "must not type" });
        yield* send("frame", {
          data: "/9j/2Q==",
          metadata: { deviceWidth: 1280, deviceHeight: 800 },
        });
        expect(yield* Queue.take(viewer.output)).toEqual({
          _tag: "viewport",
          width: 1280,
          height: 800,
        });
        const frame = yield* Queue.take(viewer.output);
        expect(frame._tag).toBe("frame");
        if (frame._tag === "frame") expect([...frame.data]).toEqual([255, 216, 255, 217]);
        yield* send("status", { state: "suppressed", reason: "protected_fields" });
        expect(yield* Queue.take(viewer.output)).toEqual({ _tag: "suppressed" });
      }),
    );
    yield* Deferred.await(disconnected);
    expect(requests.at(-1)).toEqual({
      method: "GET",
      url: "http://127.0.0.1:43841/observer/stream?threadId=thread&leaseId=lease&pageId=page",
    });
    expect(requests).toHaveLength(4);
  }).pipe(Effect.scoped),
);

it.effect("ends an attached viewer when its lease closes", () =>
  Effect.gen(function* () {
    const { observer, send } = yield* fixture();
    const viewer = yield* observer.attachViewer({
      threadId: "thread",
      tabId: agentBrowserTabId("lease", "page"),
    });
    yield* Queue.take(viewer.output);
    yield* send("status", { state: "closed" });
    expect(yield* Queue.take(viewer.output)).toEqual({ _tag: "gone" });
  }).pipe(Effect.scoped),
);

it.effect(
  "links native provider leases to their T3 chat while retaining original stream provenance",
  () =>
    Effect.gen(function* () {
      const { observer, requests } = yield* fixture(
        new Map([["thread", ThreadId.make("t3-chat")]]),
      );
      expect((yield* observer.list("t3-chat")).leases).toEqual([{ ...lease, threadId: "t3-chat" }]);
      expect((yield* observer.list("thread")).leases).toEqual([]);
      const viewer = yield* observer.attachViewer({
        threadId: "t3-chat",
        tabId: agentBrowserTabId("lease", "page"),
      });
      yield* Queue.take(viewer.output);
      expect(requests.at(-1)?.url).toBe(
        "http://127.0.0.1:43841/observer/stream?threadId=thread&leaseId=lease&pageId=page",
      );
    }).pipe(Effect.scoped),
);
