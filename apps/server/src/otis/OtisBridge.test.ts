import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { it, expect } from "@effect/vitest";
import {
  OtisFront,
  OtisTreeBatch,
  clientRpcRequiredScopes,
  type OtisFleetEvent,
  type OtisFrontUpdate,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as OtisBridge from "./OtisBridge.ts";
import { otisRpcHandlers } from "./otisRpc.ts";
import {
  applyFleetEvent,
  offlineFleet,
} from "../../../../packages/client-runtime/src/otis/tree.ts";

const decodeFixtureBatch = Schema.decodeUnknownEffect(Schema.fromJsonString(OtisTreeBatch));
const decodeTurnRequest = Schema.decodeUnknownEffect(OtisFront.TurnRequest);
const decodeTurnAccepted = Schema.decodeUnknownEffect(OtisFront.TurnAccepted);
const producerFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* path.fromFileUrl(new URL("./fixtures/tree-stream.ndjson", import.meta.url));
  const fixture = (yield* fs.readFileString(file)).trimEnd().split(/\r?\n/);
  return { fixture, batches: yield* Effect.forEach(fixture, (line) => decodeFixtureBatch(line)) };
}).pipe(Effect.provide(NodeServices.layer));

it.effect("posts typed turns and forwards the Otis fixture stream across a reconnect", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixture = (yield* fs.readFileString(
      yield* path.fromFileUrl(new URL("./fixtures/front-events.ndjson", import.meta.url)),
    ))
      .trimEnd()
      .split(/\r?\n/);
    const bodies = JSON.parse(
      yield* fs.readFileString(
        yield* path.fromFileUrl(new URL("./fixtures/front-bodies.json", import.meta.url)),
      ),
    );
    const turn = yield* decodeTurnRequest(bodies.TurnRequest[0]);
    const accepted = yield* decodeTurnAccepted(bodies.TurnAccepted[0]);
    const first = feed();
    const second = feed();
    const cursors: Array<string | null> = [];
    const posted: unknown[] = [];
    const bridge = yield* OtisBridge.make({
      origin: "http://localhost:5197",
      token: "fixture",
      reconnect: Effect.never,
      fetch: async (url, init) => {
        const route = new URL(String(url));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture");
        expect(init?.redirect).toBe("error");
        if (route.pathname === "/api/v1/front/turns") {
          expect(init?.method).toBe("POST");
          posted.push(JSON.parse(String(init?.body)));
          return Response.json(accepted);
        }
        expect(route.pathname).toBe("/api/v1/front/events");
        cursors.push(route.searchParams.get("after"));
        return cursors.length === 1 ? first.response : second.response;
      },
    });
    const rpc = yield* otisRpcHandlers.pipe(Effect.provideService(OtisBridge.OtisBridge, bridge));
    expect(yield* rpc["otis.front.turn"](turn)).toEqual(accepted);
    expect(yield* rpc["otis.front.turn"](turn)).toEqual(accepted);
    expect(posted).toEqual([turn, turn]);
    const updates = yield* Queue.unbounded<OtisFrontUpdate>();
    yield* Stream.runForEach(rpc["otis.front.subscribe"]({}), (event) =>
      Queue.offer(updates, event),
    ).pipe(Effect.forkScoped);
    expect(yield* Queue.take(updates)).toEqual({ type: "connected" });
    for (const line of fixture.slice(0, 5)) {
      first.line(line);
      expect(yield* Queue.take(updates)).toEqual(OtisFront.decodeFrontStreamLine(line));
    }
    first.close();
    expect(yield* Queue.take(updates)).toEqual({ type: "connected" });
    for (const line of fixture.slice(4)) second.line(line);
    for (const line of fixture.slice(5)) {
      const expected = OtisFront.decodeFrontStreamLine(line);
      if (OtisFront.isKnownFrontEvent(expected))
        expect(yield* Queue.take(updates)).toEqual(expected);
    }
    expect(cursors).toEqual([null, "5"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

function feed() {
  let sink!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        sink = controller;
      },
    }),
  );
  return {
    response,
    line: (text: string) => sink.enqueue(new TextEncoder().encode(text + "\n")),
    close: () => sink.close(),
  };
}
const connect = Effect.fn("test.connect")(function* (
  bridge: Effect.Success<ReturnType<typeof OtisBridge.make>>,
) {
  const events = yield* Queue.unbounded<OtisFleetEvent>();
  const fiber = yield* Stream.runForEach(bridge.subscribe, (event) =>
    Queue.offer(events, event),
  ).pipe(Effect.forkScoped);
  return { next: Queue.take(events), fiber };
});

it.effect("reads authenticated daily Otis lane usage", () =>
  Effect.gen(function* () {
    const since = "2026-11-24";
    const until = "2026-11-25";
    const row = {
      period: since,
      lane: "lane:example",
      provider: "claude-code",
      usage: { costUsd: 4.25, complete: true, records: 2, pricedRecords: 2 },
    };
    const bridge = yield* OtisBridge.make({
      origin: "http://localhost:5197",
      token: "fixture",
      reconnect: Effect.never,
      fetch: async (url, init) => {
        const path = new URL(String(url));
        expect(path.pathname).toBe("/api/v1/lanes/usage");
        expect(Object.fromEntries(path.searchParams)).toEqual({ since, until, groupBy: "day" });
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture");
        return Response.json({ since, until, rows: [row] });
      },
    });
    const rpc = yield* otisRpcHandlers.pipe(Effect.provideService(OtisBridge.OtisBridge, bridge));
    expect(yield* rpc["otis.usage"]({ since, until })).toMatchObject({
      since,
      until,
      rows: [{ ...row, usage: { costUsd: 4.25, complete: true, records: 2 } }],
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "replays the producer fixture to ten clients, snapshots reconnects, and leaves T3 SQLite unchanged",
  () =>
    Effect.gen(function* () {
      const { fixture, batches } = yield* producerFixture;
      const sql = yield* SqlClient.SqlClient;
      const schema = sql`SELECT name, sql FROM sqlite_schema ORDER BY name`;
      const changes = sql`SELECT total_changes() AS changes`;
      const tables = yield* schema;
      const initialChanges = yield* changes;
      const tree = feed(),
        waiting = feed();
      const paths: string[] = [];
      const bridge = yield* OtisBridge.make({
        origin: "http://localhost:5197",
        token: "fixture",
        reconnect: Effect.never,
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname;
          paths.push(path);
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture");
          expect(init?.redirect).toBe("error");
          if (path.endsWith("/tree-stream")) return tree.response;
          if (path.endsWith("/waiting-stream")) return waiting.response;
          if (path.endsWith("/act")) return Response.json({ accepted: true });
          if (path.endsWith("/tree-read")) {
            expect(JSON.parse(String(init?.body))).toEqual({
              parent: "lane:otis-1",
              settled: true,
            });
            return Response.json({ nodes: [], next: null });
          }
          if (path.endsWith("/tail"))
            return Response.json({
              nodeId: "sample",
              items: [],
              prev: null,
              next: null,
              end: true,
            });
          throw Error("Unexpected route");
        },
      });
      const rpc = yield* otisRpcHandlers.pipe(Effect.provideService(OtisBridge.OtisBridge, bridge));
      const clients = yield* Effect.forEach(Array.from({ length: 10 }), () => connect(bridge));
      for (const client of clients) expect((yield* client.next).type).toBe("unavailable");
      for (const [i, line] of fixture.entries()) {
        tree.line(line);
        for (const client of clients) {
          const frame = yield* client.next;
          expect(frame).toMatchObject({
            type: i === 0 || batches[i]!.reset ? "snapshot" : "delta",
            seq: batches[i]!.seq,
          });
        }
      }
      waiting.line(JSON.stringify({ lanes: [] }));
      for (const client of clients)
        expect(yield* client.next).toEqual({ type: "waiting", waiting: { lanes: [] } });
      tree.line(
        JSON.stringify({
          load: {
            host: "PC",
            at: "2026-11-23T05:00:00Z",
            memPct: 51,
            cpuPct: 5,
            running: 2,
            queued: 0,
            room: 3,
          },
        }),
      );
      for (const client of clients) expect((yield* client.next).type).toBe("load");
      yield* Fiber.interrupt(clients[0]!.fiber);
      const again = yield* connect(bridge);
      const snapshot = yield* again.next;
      expect(snapshot.type).toBe("snapshot");
      const state = applyFleetEvent(offlineFleet, snapshot);
      const last = batches.at(-1)!;
      expect([...state.nodes.keys()].sort()).toEqual(last.nodes.map((node) => node.id).sort());
      expect(state.waiting).toEqual({ lanes: [] });
      expect(state.load?.room).toBe(3);
      const page = yield* rpc["otis.subscribe"]({
        read: { parent: "lane:otis-1", settled: true },
      }).pipe(Stream.runCollect);
      expect(page).toEqual([{ type: "read", result: { nodes: [], next: null } }]);
      yield* rpc["otis.act"]({ type: "seen", nodeId: "sample", requestId: "mark-1" });
      yield* rpc["otis.nodeTail"]({ nodeId: "sample" });
      expect(paths.sort()).toEqual(
        ["nodes/act", "nodes/sample/tail", "tree-read", "tree-stream", "waiting-stream"]
          .map((p) => "/api/v1/lanes/" + p)
          .sort(),
      );
      expect(yield* changes).toEqual(initialChanges);
      expect(yield* schema).toEqual(tables);
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "selects stock on refusal, restores the fleet on recovery, and resumes after the last committed batch",
  () =>
    Effect.gen(function* () {
      const { fixture, batches } = yield* producerFixture;
      const retries = yield* Queue.unbounded<void>();
      const failed = yield* Deferred.make<void>();
      const tree = feed(),
        resumed = feed(),
        waiting = feed();
      const paths: string[] = [];
      const bridge = yield* OtisBridge.make({
        origin: "http://127.0.0.1",
        token: "fixture",
        reconnect: Deferred.succeed(failed, undefined).pipe(Effect.andThen(Queue.take(retries))),
        fetch: async (url) => {
          const path = new URL(String(url));
          if (path.pathname.endsWith("waiting-stream")) return waiting.response;
          paths.push(path.search);
          if (paths.length === 1) throw Error("refused");
          return paths.length === 2 ? tree.response : resumed.response;
        },
      });
      const client = yield* connect(bridge);
      yield* Deferred.await(failed);
      let state = applyFleetEvent(offlineFleet, yield* client.next);
      expect(state).toMatchObject({
        sidebar: "stock",
        explanation: "Otis is not answering. Showing all chats.",
      });
      yield* Queue.offer(retries, undefined);
      tree.line(fixture[0]!);
      state = applyFleetEvent(state, yield* client.next);
      expect(state.sidebar).toBe("otis");
      tree.close();
      state = applyFleetEvent(state, yield* client.next);
      expect(state.sidebar).toBe("stock");
      yield* Queue.offer(retries, undefined);
      resumed.line(fixture[1]!);
      state = applyFleetEvent(state, yield* client.next);
      expect(state.nodes.size).toBe(batches[0]!.nodes.length + 1);
      expect(paths).toEqual(["", "", `?after=${batches[0]!.seq}`]);
    }),
);

it.effect("reads the local fleet and transcript without granting actions", () =>
  Effect.gen(function* () {
    const { fixture } = yield* producerFixture;
    const tree = feed();
    const waiting = feed();
    const calls: string[] = [];
    const bridge = yield* OtisBridge.make({
      localReadOrigin: "http://127.0.0.1:5197",
      reconnect: Effect.never,
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        const headers = new Headers(init?.headers);
        expect(headers.get("x-otis-actor")).toBe("user:local");
        expect(headers.has("authorization")).toBe(false);
        if (path.endsWith("/tree-stream")) return tree.response;
        if (path.endsWith("/waiting-stream")) return waiting.response;
        if (path.endsWith("/tree-read")) return Response.json({ nodes: [], next: null });
        if (path.endsWith("/nodes/lane%3Aotis-1/tail")) {
          expect(JSON.parse(String(init?.body))).toEqual({ after: 10 });
          return Response.json({
            nodeId: "lane:otis-1",
            items: [],
            prev: null,
            next: null,
            end: true,
          });
        }
        throw Error("Unexpected route");
      },
    });
    expect(yield* bridge.read({ parent: "lane:otis-1", settled: true })).toEqual({
      nodes: [],
      next: null,
    });
    const client = yield* connect(bridge);
    expect((yield* client.next).type).toBe("unavailable");
    tree.line(fixture[0]!);
    expect((yield* client.next).type).toBe("snapshot");
    const action = yield* Effect.flip(
      bridge.act({ type: "seen", nodeId: "run", requestId: "one" }),
    );
    const tail = yield* bridge.tail({ nodeId: "lane:otis-1", after: 10 });
    expect(action.reason).toBe("unconfigured");
    expect(tail.nodeId).toBe("lane:otis-1");
    expect(calls.some((path) => path.endsWith("/nodes/act"))).toBe(false);
  }),
);

it.effect("grants local T3 only worker replies and keeps the bearer off reads", () =>
  Effect.gen(function* () {
    const message = {
      type: "message",
      nodeId: "run",
      requestId: "reply",
      text: "Continue.",
    } as const;
    const paths: string[] = [];
    const bridge = yield* OtisBridge.make({
      localReadOrigin: "http://127.0.0.1:5197",
      localActionToken: "fixture",
      reconnect: Effect.never,
      fetch: async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        paths.push(pathname);
        const headers = new Headers(init?.headers);
        expect(headers.get("x-otis-actor")).toBe("user:local");
        if (pathname.endsWith("/nodes/act")) {
          expect(headers.get("authorization")).toBe("Bearer fixture");
          expect(JSON.parse(String(init?.body))).toEqual(message);
          return Response.json({ accepted: true });
        }
        expect(headers.has("authorization")).toBe(false);
        return Response.json({ nodes: [], next: null });
      },
    });
    yield* bridge.read({ nodeId: "run" });
    const denied = yield* Effect.flip(
      bridge.act({ type: "seen", nodeId: "run", requestId: "one" }),
    );
    expect(denied.reason).toBe("unconfigured");
    expect(yield* bridge.act(message)).toEqual({ accepted: true });
    expect(paths).toEqual(["/api/v1/lanes/tree-read", "/api/v1/lanes/nodes/act"]);
  }),
);

it.effect("keeps the bearer on loopback and separates read from operate grants", () =>
  Effect.gen(function* () {
    for (const origin of [
      "https://example.com",
      "http://localhost:80/wrong",
      "http://user@localhost",
    ]) {
      let calls = 0;
      const bridge = yield* OtisBridge.make({
        origin,
        token: "fixture",
        fetch: async () => {
          calls++;
          return new Response();
        },
        reconnect: Effect.never,
      });
      const error = yield* Effect.flip(
        bridge.act({ type: "seen", nodeId: "run", requestId: "one" }),
      );
      expect(error.reason).toBe("unconfigured");
      expect(calls).toBe(0);
    }
    expect(clientRpcRequiredScopes("otis.act", {})).toEqual(["orchestration:operate"]);
    expect(clientRpcRequiredScopes("otis.nodeTail", {})).toEqual(
      clientRpcRequiredScopes("otis.subscribe", {}),
    );
  }),
);

it.effect(
  "opens a native lane through the active provider thread and keeps its hook identity when binding",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, active_provider_thread_id, created_at, updated_at, payload_json)
        VALUES ('thread','project','Fixture','claudeAgent','default','default','current','2026-01-01','2026-01-01','{"modelSelection":{"model":"opus"}}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, driver, status, updated_at, payload_json)
        VALUES ('current','thread','claudeAgent','claudeAgent','active','2026-01-01','{"nativeThreadRef":{"nativeId":"native"}}')`;
      const { resolveChats, parentBinding } = OtisBridge.nativeChats(sql, "pc");
      const { batches } = yield* producerFixture;
      const lane = {
        ...batches[0]!.nodes[0]!,
        provider: "claude-app",
        chat: { host: "otis" as const, threadId: "native" },
      };
      expect((yield* resolveChats([lane]))[0]?.chat).toEqual({
        host: "t3",
        environmentId: "pc",
        threadId: "thread",
      });
      expect(yield* parentBinding("thread", "RimWorld Mods")).toMatchObject({
        host: "claude-app",
        hostThreadId: "native",
        title: "RimWorld Mods",
        assignedLaneId: "rimworld-mods",
        takeover: false,
      });
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at='archived'`;
      expect((yield* resolveChats([lane]))[0]).toBe(lane);
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);
