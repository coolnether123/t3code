import { AgentBrowserLeaseList, agentBrowserTabId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  ServerBrowserLaunchError,
  ServerBrowserTabNotFoundError,
  type ServerBrowserViewer,
  type ServerBrowserViewerOutput,
} from "./ServerBrowser.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const OBSERVER_ORIGIN = "http://127.0.0.1:43841";
const ObserverFrame = Schema.Struct({
  data: Schema.String.check(Schema.isBase64(), Schema.isMaxLength(8 * 1024 * 1024)),
  metadata: Schema.Struct({
    deviceWidth: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
    deviceHeight: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
  }),
});
const ObserverStatus = Schema.Struct({ state: Schema.Literals(["live", "suppressed", "closed"]) });
const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(ObserverFrame));
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(ObserverStatus));

export class AgentBrowserObserverError extends Schema.TaggedError<AgentBrowserObserverError>()(
  "AgentBrowserObserverError",
  { operation: Schema.Literals(["list", "stream"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return "The agent browser observer is unavailable.";
  }
}

export class AgentBrowserObserver extends Context.Service<
  AgentBrowserObserver,
  {
    readonly list: (
      threadId?: string,
    ) => Effect.Effect<AgentBrowserLeaseList, AgentBrowserObserverError>;
    readonly attachViewer: (input: {
      readonly threadId: string;
      readonly tabId: string;
    }) => Effect.Effect<
      ServerBrowserViewer,
      ServerBrowserTabNotFoundError | ServerBrowserLaunchError,
      Scope.Scope
    >;
  }
>()("t3/preview/AgentBrowserObserver") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const tokenPath = path.join(home, ".local/share/workroom-dispatcher/shared-mcp/token");

  const request = Effect.fn("AgentBrowserObserver.request")(function* (
    route: string,
    params: Readonly<Record<string, string>>,
  ) {
    const token = (yield* fs.readFileString(tokenPath)).trim();
    return yield* HttpClientRequest.get(`${OBSERVER_ORIGIN}${route}`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
      HttpClientRequest.setUrlParams(params),
      http.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  });

  const resolveLeases = Effect.fn("AgentBrowserObserver.resolveLeases")(
    function* () {
      const response = yield* request("/observer/leases", {});
      const result = yield* HttpClientResponse.schemaBodyJson(AgentBrowserLeaseList)(response);
      const owners = yield* projections.getNativeThreadOwners(
        result.leases.map((lease) => lease.threadId),
      );
      return {
        result,
        leases: result.leases.map((lease) => ({
          source: lease,
          resolved: { ...lease, threadId: owners.get(lease.threadId) ?? lease.threadId },
        })),
      };
    },
    Effect.scoped,
    Effect.timeout("5 seconds"),
    Effect.mapError((cause) => new AgentBrowserObserverError({ operation: "list", cause })),
  );

  const list = Effect.fn("AgentBrowserObserver.list")(function* (threadId?: string) {
    const { result, leases } = yield* resolveLeases();
    return {
      ...result,
      leases: leases
        .map(({ resolved }) => resolved)
        .filter((lease) => threadId === undefined || lease.threadId === threadId),
    };
  });

  const attachViewer = Effect.fn("AgentBrowserObserver.attachViewer")(function* (input: {
    readonly threadId: string;
    readonly tabId: string;
  }) {
    const listed = yield* resolveLeases().pipe(
      Effect.mapError((cause) => new ServerBrowserLaunchError({ cause })),
    );
    const lease = listed.leases.find(
      ({ resolved }) =>
        resolved.threadId === input.threadId &&
        resolved.pages.some(
          (page) => agentBrowserTabId(resolved.leaseId, page.pageId) === input.tabId,
        ),
    )?.source;
    const page = lease?.pages.find(
      (candidate) => agentBrowserTabId(lease.leaseId, candidate.pageId) === input.tabId,
    );
    if (lease === undefined || page === undefined)
      return yield* new ServerBrowserTabNotFoundError(input);

    const response = yield* request("/observer/stream", {
      threadId: lease.threadId,
      leaseId: lease.leaseId,
      pageId: page.pageId,
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) => new ServerBrowserLaunchError({ cause })),
    );
    const output = yield* Queue.make<ServerBrowserViewerOutput>({ capacity: 4 });
    yield* Queue.offer(output, {
      _tag: "control",
      canOperate: false,
      controller: "agent",
      generation: 0,
      dialog: null,
    });

    // Frames are frequent and share the enclosing viewer span.
    const receive = Effect.fnUntraced(function* (event: Sse.Event) {
      if (event.event === "frame") {
        const frame = yield* decodeFrame(event.data);
        yield* Queue.offer(output, {
          _tag: "viewport",
          width: Math.round(frame.metadata.deviceWidth),
          height: Math.round(frame.metadata.deviceHeight),
        });
        yield* Queue.offer(output, {
          _tag: "frame",
          data: Buffer.from(frame.data, "base64"),
          ack: Effect.void,
        });
      } else if (event.event === "status") {
        const status = yield* decodeStatus(event.data);
        if (status.state === "closed") yield* Queue.offer(output, { _tag: "gone" });
        if (status.state === "suppressed") yield* Queue.offer(output, { _tag: "suppressed" });
      }
    });
    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 10 * 1024 * 1024 })),
      Stream.runForEach(receive),
      Effect.ensuring(Queue.offer(output, { _tag: "gone" })),
      Effect.ignore,
      Effect.forkScoped,
    );
    return { output, input: () => Effect.void } satisfies ServerBrowserViewer;
  });

  return AgentBrowserObserver.of({ list, attachViewer });
});

export const layer = Layer.effect(AgentBrowserObserver, make);
