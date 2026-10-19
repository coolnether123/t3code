import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import Compatibility from "./050_ProjectionThreadsActiveOrderKeyCompatibility.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "050_ProjectionThreadsSchemaCompatibility",
  (it) => {
    it.effect("adds missing compatibility columns without changing historical thread rows", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 47 });
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-compat', 'project-compat', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
        yield* Compatibility;
        yield* Compatibility;
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        const rows = yield* sql<{
          readonly activeOrderKey: string | null;
          readonly branchPullRequest: string | null;
        }>`
        SELECT active_order_key AS "activeOrderKey", branch_pull_request_json AS "branchPullRequest"
        FROM projection_threads WHERE thread_id = 'thread-compat'
      `;
        const count = yield* sql<{
          readonly count: number;
        }>`SELECT count(*) AS count FROM projection_threads`;
        assert.isTrue(columns.some((column) => column.name === "active_order_key"));
        assert.isTrue(columns.some((column) => column.name === "branch_pull_request_json"));
        assert.deepEqual(rows, [{ activeOrderKey: null, branchPullRequest: null }]);
        assert.deepEqual(count, [{ count: 1 }]);
      }),
    );
  },
);
