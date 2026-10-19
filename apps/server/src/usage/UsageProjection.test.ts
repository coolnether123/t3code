import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as UsageProjection from "./UsageProjection.ts";

it.layer(NodeSqliteClient.layerMemory())("V2 usage projection", (it) => {
  it.effect("maps exact native sessions and preserves ambiguous matches", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, created_at TEXT, updated_at TEXT, payload_json TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, driver TEXT, payload_json TEXT)`;
      yield* sql`CREATE TABLE orchestration_events (sequence INTEGER)`;
      yield* sql`INSERT INTO orchestration_events VALUES (5)`;
      for (const [thread, strength] of [
        ["one", "strong"],
        ["two", "strong"],
        ["weak", "weak"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES (${thread}, 'codex', ${JSON.stringify({ nativeThreadRef: { nativeId: "synthetic-native-session", strength } })})`;
      }
      const context = yield* Layer.build(UsageProjection.layer);
      const projection = Context.get(context, UsageProjection.UsageProjection);
      assert.strictEqual((yield* projection.getSnapshotSequence()).snapshotSequence, 5);
      const query = projection.findThreadMappingsByProviderSessionIds;
      assert(query !== undefined);
      const mappings = yield* query(["synthetic-native-session"]);
      assert.deepStrictEqual(
        mappings
          .toSorted((a, b) => a.threadId.localeCompare(b.threadId))
          .map((row) => ({ threadId: row.threadId, threadCount: row.threadCount })),
        [
          { threadId: "one", threadCount: 2 },
          { threadId: "two", threadCount: 2 },
        ],
      );
    }).pipe(Effect.scoped),
  );
});
