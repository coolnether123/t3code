import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import Workers from "./forkWorkersMigration.fixture.ts";
import Compatibility from "./Migrations/050_ProjectionThreadsActiveOrderKeyCompatibility.ts";
import Compactions from "./Migrations/051_ProjectionThreadContextCompactions.ts";
import BootstrapCompactions from "./Migrations/052_BootstrapThreadContextCompactions.ts";
import PromptIndex from "./Migrations/053_PromptUsageMessageIndex.ts";
import IdentityIndex from "./Migrations/054_UserMessageIdentityIndex.ts";
import PromptWords from "./Migrations/055_PromptWordIndex.ts";

const forkTail = [
  [50, "ProjectionThreadsActiveOrderKeyCompatibility", Compatibility],
  [51, "ProjectionThreadContextCompactions", Compactions],
  [52, "BootstrapThreadContextCompactions", BootstrapCompactions],
  [53, "PromptUsageMessageIndex", PromptIndex],
  [54, "UserMessageIdentityIndex", IdentityIndex],
  [55, "PromptWordIndex", PromptWords],
] as const;

const forkDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 49 });
  yield* Workers;
  yield* sql`ALTER TABLE projection_threads DROP COLUMN linked_pull_request_json`;
  yield* sql`UPDATE effect_sql_migrations SET name = 'Workers' WHERE migration_id = 41`;
  yield* sql`UPDATE effect_sql_migrations SET name = 'AuthSessionClientConnection' WHERE migration_id = 42`;
  for (const [id, name, migrate] of forkTail) {
    yield* migrate;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
  }
  yield* sql`INSERT INTO t3_workers (worker_id, parent_thread_id, status, updated_at, payload_json)
    VALUES ('synthetic-worker', 'synthetic-parent', 'idle', '2026-10-19T06:00:00Z', '{"synthetic":true}')`;
});

describe("fork migration compatibility", () => {
  it.effect("upgrades the shipped fork ledger through V2 and retains Worker data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* forkDatabase;
      yield* runMigrations();
      const names = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        names.map((row) => [row.migration_id, row.name]),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      const audit = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM t3_fork_migration_history WHERE migration_id = 55`;
      assert.strictEqual(audit[0]?.name, "PromptWordIndex");
      const tables =
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_events'`;
      assert.lengthOf(tables, 1);
      const workers = yield* sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM t3_workers WHERE worker_id = 'synthetic-worker'`;
      assert.strictEqual(workers[0]?.payload_json, '{"synthetic":true}');
      yield* runMigrations();
      assert.lengthOf(yield* sql`SELECT * FROM t3_fork_migration_history`, 8);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves an unrecognized later fork history unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* forkDatabase;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (56, 'UnknownForkChange')`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      assert.lengthOf(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 't3_fork_migration_history'`,
        0,
      );
      assert.lengthOf(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_events'`,
        0,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
