import {
  OtisActionResult,
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

interface Bridge {
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
const decodeTail = Schema.decodeUnknownEffect(OtisTailPage);
const decodeTreeRead = Schema.decodeUnknownEffect(OtisTreeReadResult);
const invalidResponse = () => new OtisRpcError({ reason: "invalid-response" });
const unreachable = () => new OtisRpcError({ reason: "unavailable" });

export const make = Effect.fn("OtisBridge.make")(function* (options: {
  readonly origin?: string | undefined;
  readonly token?: string | undefined;
  readonly fetch?: typeof fetch;
  readonly reconnect: Effect.Effect<void>;
}) {
  const origin = configuredOrigin(options.origin);
  if (!origin || !options.token) return yield* OtisBridge;
  const fetchImpl = options.fetch ?? (yield* FetchHttpClient.Fetch);
  const encodeBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const headers = { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" };
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

  const post = Effect.fn("OtisBridge.post")(function* (path: string, body: unknown) {
    const response = yield* request(path, body);
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: invalidResponse,
    });
  });
  const act = Effect.fn("OtisBridge.act")(function* (input: OtisAction) {
    const path = input.type === "child.start" ? "children" : "nodes/act";
    return yield* decodeAction(yield* post(path, input)).pipe(Effect.mapError(invalidResponse));
  });
  const tail = Effect.fn("OtisBridge.tail")(function* ({ nodeId, ...page }: OtisTailInput) {
    const raw = yield* post(`nodes/${encodeURIComponent(nodeId)}/tail`, page);
    const result = yield* decodeTail(raw).pipe(Effect.mapError(invalidResponse));
    if (result.nodeId !== nodeId) return yield* invalidResponse();
    return result;
  });
  const read = Effect.fn("OtisBridge.read")(function* (query: OtisTreeRead) {
    const raw = yield* post("tree-read", query);
    return yield* decodeTreeRead(raw).pipe(Effect.mapError(invalidResponse));
  });
  return { act, tail, subscribe, read } satisfies Bridge;
});

export const layer = Layer.effect(
  OtisBridge,
  make({
    origin: process.env.T3_OTIS_ORIGIN,
    token: process.env.T3_OTIS_TOKEN,
    reconnect: Effect.sleep("2 seconds"),
  }),
);
