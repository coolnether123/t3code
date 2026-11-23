import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { it, expect } from "@effect/vitest";
import { OtisTreeBatch, clientRpcRequiredScopes, type OtisFleetEvent } from "@t3tools/contracts";
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
const producerFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* path.fromFileUrl(new URL("./fixtures/tree-stream.ndjson", import.meta.url));
  const fixture = (yield* fs.readFileString(file)).trimEnd().split(/\r?\n/);
  return { fixture, batches: yield* Effect.forEach(fixture, (line) => decodeFixtureBatch(line)) };
}).pipe(Effect.provide(NodeServices.layer));

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
