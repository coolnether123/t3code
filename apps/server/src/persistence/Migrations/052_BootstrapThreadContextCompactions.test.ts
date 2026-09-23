import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import bootstrapThreadContextCompactions from "./052_BootstrapThreadContextCompactions.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_BootstrapThreadContextCompactions", (it) => {
  it.effect("fast-forwards only when no compaction events need replay", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-before-compaction', 'thread', 'thread-1', 1, 'thread.created',
          '2026-09-23T00:00:00.000Z', 'command-1', NULL, NULL, 'client', '{}', '{}'
        )
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.thread-context-compactions', 0, '2026-09-23T00:00:00.000Z')
      `;

      yield* bootstrapThreadContextCompactions;
      const rows = yield* sql<{ last_applied_sequence: number }>`
        SELECT last_applied_sequence FROM projection_state
        WHERE projector = 'projection.thread-context-compactions'
      `;
      assert.strictEqual(rows[0]?.last_applied_sequence, 1);
      yield* sql`DELETE FROM projection_state WHERE projector = 'projection.thread-context-compactions'`;
      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-with-compaction', 'thread', 'thread-1', 1,
          'thread.context-compaction-started', '2026-09-23T00:00:00.000Z',
          'command-1', NULL, NULL, 'client', '{}', '{}'
        )
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.thread-context-compactions', 0, '2026-09-23T00:00:00.000Z')
      `;

      yield* bootstrapThreadContextCompactions;
      const replayRows = yield* sql<{ last_applied_sequence: number }>`
        SELECT last_applied_sequence FROM projection_state
        WHERE projector = 'projection.thread-context-compactions'
      `;
      assert.strictEqual(replayRows[0]?.last_applied_sequence, 0);
    }),
  );
});
