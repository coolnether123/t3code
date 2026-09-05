import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const remote40Layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const forkLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const officialLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const columnNames = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table}) ORDER BY cid
    `;
    return rows.map((row) => row.name);
  });

const latestMigrationRows = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly migrationId: number; readonly name: string }>`
      SELECT migration_id AS "migrationId", name
      FROM effect_sql_migrations
      ORDER BY migration_id DESC
      LIMIT 2
    `;
  });

freshLayer("048_049 fresh database", (it) => {
  it.effect("migrates through both compatibility tails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const executed = yield* runMigrations();

      assert.deepEqual(executed.at(-2), [48, "ProjectionThreadLinkedPullRequestCompatibility"]);
      assert.deepEqual(executed.at(-1), [49, "WorkersCompatibility"]);
      assert.ok((yield* columnNames("projection_threads")).includes("linked_pull_request_json"));
      assert.ok((yield* columnNames("projection_projects")).includes("project_icon_json"));
      assert.ok((yield* columnNames("projection_projects")).includes("auto_pull"));
      assert.ok((yield* columnNames("projection_threads")).includes("unsettled_at"));
      assert.ok((yield* columnNames("t3_workers")).includes("worker_id"));

      const migrations = yield* latestMigrationRows();
      assert.deepEqual(migrations, [
        { migrationId: 49, name: "WorkersCompatibility" },
        { migrationId: 48, name: "ProjectionThreadLinkedPullRequestCompatibility" },
      ]);
      assert.deepEqual(yield* runMigrations(), []);
      const workerCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM t3_workers
      `;
      assert.equal(workerCount[0]?.count, 0);
    }),
  );
});

remote40Layer("048_049 remote official 40 history", (it) => {
  it.effect("preserves pre-fork event data while completing the manifest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'remote40-event', 'project', 'remote40-project', 0, 'project.created',
          '2026-09-05T00:00:00.000Z', 'remote40-command', NULL, 'remote40-command',
          'client', '{"name":"preserve"}', '{}'
        )
      `;

      const executed = yield* runMigrations();
      assert.deepEqual(
        executed.map(([id]) => id),
        [41, 42, 43, 44, 45, 46, 47, 48, 49],
      );
      const event = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload
        FROM orchestration_events
        WHERE event_id = 'remote40-event'
      `;
      assert.deepEqual(event, [{ payload: '{"name":"preserve"}' }]);
      assert.ok((yield* columnNames("auth_sessions")).includes("client_surface"));
      assert.ok((yield* columnNames("t3_workers")).includes("worker_id"));
    }),
  );
});

forkLayer("048_049 fork history", (it) => {
  it.effect("preserves migration 42 data while applying upstream 43-47", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* sql`
        INSERT INTO t3_workers (
          worker_id, parent_thread_id, status, updated_at, payload_json
        ) VALUES (
          'worker-preserved', 'thread-parent', 'running',
          '2026-09-05T00:00:00.000Z', '{"source":"fork42"}'
        )
      `;

      const executed = yield* runMigrations();
      assert.deepEqual(
        executed.map(([id]) => id),
        [43, 44, 45, 46, 47, 48, 49],
      );
      const worker = yield* sql<{
        readonly workerId: string;
        readonly payload: string;
      }>`
        SELECT worker_id AS "workerId", payload_json AS payload
        FROM t3_workers
        WHERE worker_id = 'worker-preserved'
      `;
      assert.deepEqual(worker, [{ workerId: "worker-preserved", payload: '{"source":"fork42"}' }]);
      assert.ok((yield* columnNames("projection_threads")).includes("linked_pull_request_json"));
      assert.ok((yield* columnNames("t3_workers")).includes("worker_id"));
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(yield* latestMigrationRows(), [
        { migrationId: 49, name: "WorkersCompatibility" },
        { migrationId: 48, name: "ProjectionThreadLinkedPullRequestCompatibility" },
      ]);
    }),
  );
});

officialLayer("048_049 official history", (it) => {
  it.effect("upgrades upstream 47 without changing its rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });

      // Recreate the schema and migration ledger produced by upstream 47.
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN client_surface TEXT`;
      yield* sql`ALTER TABLE auth_sessions ADD COLUMN client_app_version TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN linked_pull_request_json TEXT`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN unsettled_at TEXT`;
      yield* sql`ALTER TABLE projection_projects ADD COLUMN auto_pull INTEGER NOT NULL DEFAULT 0`;
      yield* sql`ALTER TABLE projection_projects ADD COLUMN project_icon_json TEXT`;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json,
          created_at, updated_at, linked_pull_request_json, unsettled_at
        ) VALUES (
          'official-thread', 'official-project', 'Preserve this row',
          '{"provider":"codex","model":"gpt-5.6-sol"}',
          '2026-09-01T00:00:00.000Z', '2026-09-05T00:00:00.000Z',
          '{"url":"https://example.test/pull/7"}', NULL
        )
      `;
      for (const [migrationId, name] of [
        [41, "AuthSessionClientConnection"],
        [42, "ProjectionThreadLinkedPullRequest"],
        [43, "ProjectionThreadsUnsettledAt"],
        [44, "ClearAutomaticProjectModelDefaults"],
        [45, "ProjectionProjectsAutoPull"],
        [46, "RepairAutomaticSettlementTimestamps"],
        [47, "ProjectionProjectIcon"],
      ] as const) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${name})
        `;
      }

      const executed = yield* runMigrations();
      assert.deepEqual(executed, [
        [48, "ProjectionThreadLinkedPullRequestCompatibility"],
        [49, "WorkersCompatibility"],
      ]);
      const row = yield* sql<{ readonly linkedPullRequest: string }>`
        SELECT linked_pull_request_json AS "linkedPullRequest"
        FROM projection_threads
        WHERE thread_id = 'official-thread'
      `;
      assert.deepEqual(row, [{ linkedPullRequest: '{"url":"https://example.test/pull/7"}' }]);
      assert.ok((yield* columnNames("t3_workers")).includes("worker_id"));
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );
});
