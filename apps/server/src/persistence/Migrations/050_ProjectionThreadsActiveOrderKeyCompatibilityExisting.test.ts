import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import Compatibility from "./050_ProjectionThreadsActiveOrderKeyCompatibility.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "050_ProjectionThreadsActiveOrderKeyCompatibilityExisting",
  (it) => {
    it.effect("preserves an existing active order key across repeated compatibility runs", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 49 });
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at, active_order_key
        ) VALUES (
          'thread-existing-key', 'project-compat', 'Existing keyed thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'keep-me'
        )
      `;
        yield* Compatibility;
        yield* Compatibility;
        const row = yield* sql`
        SELECT active_order_key AS "activeOrderKey", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_threads WHERE thread_id = 'thread-existing-key'
      `;
        assert.deepEqual(row, [
          {
            activeOrderKey: "keep-me",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]);
      }),
    );
  },
);
