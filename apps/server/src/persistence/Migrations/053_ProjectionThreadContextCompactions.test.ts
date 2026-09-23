import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("053_ProjectionThreadContextCompactions", (it) => {
  it.effect("upgrades a database whose migration IDs 51 and 52 belong to the older app", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES
          (51, '2026-09-22T00:00:00.000Z', 'ProjectionThreadMessageContext'),
          (52, '2026-09-22T00:00:00.000Z', 'ProjectionThreadPullRequestsCompatibility')
      `;

      yield* runMigrations();
      yield* runMigrations();

      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id >= 51 ORDER BY migration_id
      `;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'projection_thread_context_compaction%'
        ORDER BY name
      `;
      assert.deepEqual(history, [
        { migration_id: 51, name: "ProjectionThreadMessageContext" },
        { migration_id: 52, name: "ProjectionThreadPullRequestsCompatibility" },
        { migration_id: 53, name: "ProjectionThreadContextCompactions" },
        { migration_id: 54, name: "BootstrapThreadContextCompactions" },
      ]);
      assert.deepEqual(
        tables.map(({ name }) => name),
        ["projection_thread_context_compaction_messages", "projection_thread_context_compactions"],
      );
    }),
  );
});
