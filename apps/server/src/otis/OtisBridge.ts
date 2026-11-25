import {
  OtisActionResult,
  OtisLaneUsage,
  type OtisLaneUsageInput,
  OtisRpcError,
  OtisTailPage,
  OtisTreeLine,
  OtisTreeReadResult,
  type OtisTreeRead,
  OtisWaiting,
  type OtisAction,
  type OtisFleetEvent,
  type OtisNode,
  type OtisTailInput,
} from "@t3tools/contracts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";

import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

interface Bridge {
  readonly usage: (input: OtisLaneUsageInput) => Effect.Effect<OtisLaneUsage, OtisRpcError>;
  readonly subscribe: Stream.Stream<OtisFleetEvent>;
  readonly read: (query: OtisTreeRead) => Effect.Effect<OtisTreeReadResult, OtisRpcError>;
  readonly act: (input: OtisAction) => Effect.Effect<OtisActionResult, OtisRpcError>;
  readonly tail: (input: OtisTailInput) => Effect.Effect<OtisTailPage, OtisRpcError>;
}

const unavailable = { type: "unavailable" } as const;
const unconfigured = Effect.fail(new OtisRpcError({ reason: "unconfigured" }));
// Environments without an Otis installation can still serve the stock client.
export class OtisBridge extends Context.Reference<Bridge>("t3/otis/OtisBridge", {
  defaultValue: () => ({
    usage: () => unconfigured,
    subscribe: Stream.make(unavailable),
    act: () => unconfigured,
    read: () => unconfigured,
    tail: () => unconfigured,
  }),
}) {}

function configuredOrigin(raw: string | undefined) {
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  return url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.pathname === "/" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
    ? url
    : null;
}

const treeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(OtisTreeLine));
const waitingLine = Schema.decodeUnknownEffect(Schema.fromJsonString(OtisWaiting));
const decodeAction = Schema.decodeUnknownEffect(OtisActionResult);
const decodeUsage = Schema.decodeUnknownEffect(OtisLaneUsage);
const decodeTail = Schema.decodeUnknownEffect(OtisTailPage);
const decodeTreeRead = Schema.decodeUnknownEffect(OtisTreeReadResult);
const invalidResponse = () => new OtisRpcError({ reason: "invalid-response" });
const unreachable = () => new OtisRpcError({ reason: "unavailable" });

export const make = Effect.fn("OtisBridge.make")(function* (options: {
  readonly origin?: string | undefined;
  readonly token?: string | undefined;
  readonly parentBinding?: (
    threadId: string,
    title: string,
  ) => Effect.Effect<unknown, OtisRpcError>;
  readonly resolveChats?: (nodes: readonly OtisNode[]) => Effect.Effect<readonly OtisNode[]>;
  readonly localReadOrigin?: string | undefined;
  readonly fetch?: typeof fetch;
  readonly reconnect: Effect.Effect<void>;
}) {
  const localRead =
    options.origin === undefined && options.localReadOrigin !== undefined && !options.token;
  const origin = configuredOrigin(options.origin ?? options.localReadOrigin);
  if (!origin || (!localRead && !options.token)) return yield* OtisBridge;
  const fetchImpl = options.fetch ?? (yield* FetchHttpClient.Fetch);
  const encodeBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const headers = new Headers({ "Content-Type": "application/json" });
  if (localRead) headers.set("X-Otis-Actor", "user:local");
  else headers.set("Authorization", `Bearer ${options.token}`);
  const request = Effect.fn("OtisBridge.request")(function* (path: string, body?: unknown) {
    const encoded =
      body === undefined
        ? undefined
        : yield* encodeBody(body).pipe(Effect.mapError(invalidResponse));
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchImpl(new URL(`/api/v1/lanes/${path}`, origin), {
          method: body === undefined ? "GET" : "POST",
          ...(encoded === undefined ? {} : { body: encoded }),
          signal,
          headers,
          redirect: "error",
        }),
      catch: unreachable,
    });
    if (!response.ok || !response.body) {
      if (response.body) yield* Effect.promise(() => response.body!.cancel().catch(() => {}));
      return yield* new OtisRpcError({ reason: "refused", status: response.status });
    }
    return response;
  });

  const listeners = new Set<(event: OtisFleetEvent) => void>();
  const nodes = new Map<string, OtisNode>();
  let seq: number | undefined;
  let online = false;
  let waiting: typeof OtisWaiting.Type | null = null;
  let load: Extract<OtisFleetEvent, { type: "load" }>["load"] | null = null;
  const snapshot = (): OtisFleetEvent =>
    online && seq !== undefined
      ? { type: "snapshot", seq, nodes: [...nodes.values()], waiting, load }
      : unavailable;
  const publish = (event: OtisFleetEvent) => {
    for (const send of listeners) send(event);
  };

  const subscribe = Stream.callback<OtisFleetEvent>(
    (mailbox) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          // Register and enqueue the snapshot in one synchronous turn. A delta cannot slip between them.
          const send = (event: OtisFleetEvent) => {
            if (Queue.offerUnsafe(mailbox, event)) return;
            // A slow socket can replace its pending batch with the current full snapshot.
            Queue.takeUnsafe(mailbox);
            Queue.offerUnsafe(mailbox, snapshot());
          };
          listeners.add(send);
          send(snapshot());
          return send;
        }),
        (send) =>
          Effect.sync(() => {
            listeners.delete(send);
          }),
      ),
    { bufferSize: 1 },
  );

  const lines = (path: string) =>
    Stream.unwrap(
      request(path).pipe(
        Effect.map((response) =>
          Stream.fromReadableStream({ evaluate: () => response.body!, onError: unreachable }).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.trim().length > 0),
          ),
        ),
      ),
    );
  const readTree = Effect.suspend(() =>
    lines(seq === undefined ? "tree-stream" : `tree-stream?after=${seq}`).pipe(
      Stream.mapEffect((line) => treeLine(line)),
      Stream.mapEffect((line) =>
        "nodes" in line && options.resolveChats
          ? options
              .resolveChats(line.nodes)
              .pipe(Effect.map((resolved) => ({ ...line, nodes: resolved })))
          : Effect.succeed(line),
      ),
      Stream.runForEach((line) =>
        Effect.sync(() => {
          if ("load" in line) {
            load = line.load;
            if (online) publish({ type: "load", load });
            return;
          }
          if (!line.reset && online && seq !== undefined && line.seq <= seq) return;
          if (line.reset) nodes.clear();
          for (const node of line.nodes) {
            if (node.settled) nodes.delete(node.id);
            else nodes.set(node.id, node);
          }
          seq = line.seq;
          const refresh = !online || line.reset;
          online = true;
          publish(refresh ? snapshot() : { type: "delta", ...line });
        }),
      ),
    ),
  );
  const readWaiting = lines("waiting-stream").pipe(
    Stream.mapEffect((line) => waitingLine(line)),
    Stream.runForEach((value) =>
      Effect.sync(() => {
        waiting = value;
        if (online) publish({ type: "waiting", waiting });
      }),
    ),
  );
  // Retry only after disconnect or EOF. An idle connection has no clock or read loop outside fetch.
  yield* readTree.pipe(
    Effect.ignore,
    Effect.andThen(
      Effect.sync(() => {
        const wasOnline = online;
        online = false;
        if (wasOnline) publish(unavailable);
        load = null;
      }),
    ),
    Effect.andThen(options.reconnect),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* readWaiting.pipe(
    Effect.ignore,
    Effect.andThen(
      Effect.sync(() => {
        const hadWaiting = waiting !== null;
        waiting = null;
        if (hadWaiting && online) publish({ type: "waiting", waiting: null });
      }),
    ),
    Effect.andThen(options.reconnect),
    Effect.forever,
    Effect.forkScoped,
  );

  const requestJson = Effect.fn("OtisBridge.requestJson")(function* (path: string, body?: unknown) {
    const response = yield* request(path, body);
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: invalidResponse,
    });
  });
  const act = Effect.fn("OtisBridge.act")(function* (input: OtisAction) {
    if (localRead) return yield* unconfigured;
    if (input.type === "parent.bind") {
      if (!options.parentBinding) return yield* unconfigured;
      return yield* decodeAction(
        yield* requestJson("parents", yield* options.parentBinding(input.threadId, input.title)),
      ).pipe(Effect.mapError(invalidResponse));
    }
    const path = input.type === "child.start" ? "children" : "nodes/act";
    return yield* decodeAction(yield* requestJson(path, input)).pipe(
      Effect.mapError(invalidResponse),
    );
  });
  const tail = Effect.fn("OtisBridge.tail")(function* ({ nodeId, ...page }: OtisTailInput) {
    const raw = yield* requestJson(`nodes/${encodeURIComponent(nodeId)}/tail`, page);
    const result = yield* decodeTail(raw).pipe(Effect.mapError(invalidResponse));
    if (result.nodeId !== nodeId) return yield* invalidResponse();
    return result;
  });
  const read = Effect.fn("OtisBridge.read")(function* (query: OtisTreeRead) {
    const raw = yield* requestJson("tree-read", query);
    const result = yield* decodeTreeRead(raw).pipe(Effect.mapError(invalidResponse));
    return options.resolveChats
      ? { ...result, nodes: yield* options.resolveChats(result.nodes) }
      : result;
  });
  const usage = Effect.fn("OtisBridge.usage")(function* ({ since, until }: OtisLaneUsageInput) {
    const query = new URLSearchParams({ since, until, groupBy: "day" });
    const raw = yield* requestJson(`usage?${query}`);
    return yield* decodeUsage(raw).pipe(Effect.mapError(invalidResponse));
  });
  return { act, tail, subscribe, read, usage } satisfies Bridge;
});

export function nativeChats(sql: SqlClient.SqlClient, environmentId: string) {
  return {
    parentBinding: Effect.fn("OtisBridge.parentBinding")(function* (
      threadId: string,
      title: string,
    ) {
      const [thread] = yield* sql<{
        model: string;
        driver: string | null;
        nativeId: string | null;
      }>`
          SELECT t.payload_json->>'$.modelSelection.model' AS model, p.driver,
            p.payload_json->>'$.nativeThreadRef.nativeId' AS nativeId
          FROM orchestration_v2_projection_threads t LEFT JOIN orchestration_v2_projection_provider_threads p
            ON t.active_provider_thread_id=p.provider_thread_id
          WHERE t.thread_id=${threadId} AND t.archived_at IS NULL AND t.deleted_at IS NULL
        `.pipe(Effect.mapError(unreachable));
      if (!thread?.model) return yield* new OtisRpcError({ reason: "refused", status: 404 });
      const lane =
        title
          .normalize("NFKD")
          .toLowerCase()
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || threadId;
      const nativeHost =
        thread.driver === "claudeAgent" ? "claude-app" : thread.driver === "codex" ? "codex" : null;
      const host = nativeHost && thread.nativeId ? nativeHost : "t3";
      return {
        title,
        assignedLaneId: lane,
        laneId: lane,
        environmentId,
        model: thread.model,
        host,
        hostThreadId: host === "t3" ? threadId : thread.nativeId,
        takeover: false,
      };
    }),
    resolveChats: Effect.fn("OtisBridge.resolveChats")(function* (nodes: readonly OtisNode[]) {
      const ids = nodes.flatMap((node) =>
        node.chat?.host === "otis" && node.chat.threadId ? [node.chat.threadId] : [],
      );
      if (!ids.length) return nodes;
      const matches = yield* sql<{ nativeId: string; threadId: string; driver: string }>`
          SELECT p.payload_json->>'$.nativeThreadRef.nativeId' AS nativeId, t.thread_id AS threadId, p.driver
          FROM orchestration_v2_projection_provider_threads p
          JOIN orchestration_v2_projection_threads t ON t.active_provider_thread_id=p.provider_thread_id
          WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
            AND p.payload_json->>'$.nativeThreadRef.nativeId' IN ${sql.in(ids)}
        `.pipe(Effect.orElseSucceed(() => []));
      return nodes.map((node) => {
        if (node.chat?.host !== "otis" || !node.chat.threadId) return node;
        const driver =
          node.provider === "claude-app" || node.provider === "claude-code"
            ? "claudeAgent"
            : node.provider === "codex-cli"
              ? "codex"
              : node.provider;
        const hits = matches.filter(
          (row) => row.nativeId === node.chat?.threadId && row.driver === driver,
        );
        return hits.length === 1
          ? { ...node, chat: { host: "t3" as const, environmentId, threadId: hits[0]!.threadId } }
          : node;
      });
    }),
  };
}

export const layer = Layer.effect(
  OtisBridge,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const localReadOrigin = yield* fs
      .readFileString(path.join(config.baseDir, "otis-fleet-origin"))
      .pipe(
        Effect.map((value) => value.trim()),
        Effect.orElseSucceed(() => undefined),
      );
    const sql = yield* SqlClient.SqlClient;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const environmentId = yield* identity.getEnvironmentId;
    return yield* make({
      ...nativeChats(sql, environmentId),
      origin: yield* Config.option(Config.String("T3_OTIS_ORIGIN")).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      ),
      token: yield* Config.option(Config.String("T3_OTIS_TOKEN")).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      ),
      localReadOrigin,
      reconnect: Effect.sleep("2 seconds"),
    });
  }),
);
