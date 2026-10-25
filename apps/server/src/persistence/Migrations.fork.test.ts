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
import MessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import ThreadPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";

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

const macForkDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 49 });
  yield* Workers;
  for (const [id, name] of [
    [41, "Workers"],
    [42, "AuthSessionClientConnection"],
    [48, "ProjectionThreadLinkedPullRequestCompatibility"],
    [49, "WorkersCompatibility"],
  ] as const) {
    yield* sql`UPDATE effect_sql_migrations SET name = ${name} WHERE migration_id = ${id}`;
  }
  for (const [id, name, migrate] of [
    [50, "ProjectionThreadsActiveOrderKeyCompatibility", Compatibility],
    [51, "ProjectionThreadMessageContext", MessageContext],
    [52, "ProjectionThreadPullRequestsCompatibility", ThreadPullRequests],
    [53, "ProjectionThreadContextCompactions", Compactions],
    [54, "BootstrapThreadContextCompactions", BootstrapCompactions],
  ] as const) {
    yield* migrate;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
  }
  yield* sql`CREATE TABLE approval_response_deliveries (
    thread_id TEXT NOT NULL, request_id TEXT NOT NULL, decision TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, message_id TEXT NOT NULL,
    message_text TEXT NOT NULL, route TEXT, recorded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (thread_id, request_id)
  )`;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (55, 'ApprovalResponseDeliveries')`;
  yield* sql`INSERT INTO approval_response_deliveries
    (thread_id, request_id, decision, status, message_id, message_text, created_at, updated_at)
    VALUES ('synthetic-thread', 'synthetic-request', 'accept', 'pending',
      'synthetic-message', 'synthetic delivery', '2026-10-24T00:00:00Z', '2026-10-24T00:00:00Z')`;
});

describe("fork migration compatibility", () => {
  it.effect("upgrades the deployed Mac ledger and retains approval deliveries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* macForkDatabase;
      yield* runMigrations();
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name]),
        migrationManifest.map(([id, name]) => [id, name]),
      );
      const audit = yield* sql<{ readonly name: string }>`
        SELECT name FROM t3_fork_migration_history WHERE migration_id = 55
      `;
      assert.strictEqual(audit[0]?.name, "ApprovalResponseDeliveries");
      const deliveries = yield* sql<{ readonly message_text: string; readonly status: string }>`
        SELECT message_text, status FROM approval_response_deliveries
      `;
      assert.deepStrictEqual(deliveries, [
        { message_text: "synthetic delivery", status: "pending" },
      ]);
      yield* runMigrations();
      assert.lengthOf(yield* sql`SELECT * FROM t3_fork_migration_history`, 15);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects a mixture of the two fork histories without changing it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* macForkDatabase;
      yield* sql`UPDATE effect_sql_migrations SET name = 'PromptUsageMessageIndex'
        WHERE migration_id = 53`;
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
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves an unknown earlier fork migration unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* macForkDatabase;
      yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownSettlementChange'
        WHERE migration_id = 43`;
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
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back ledger and schema repairs when a prerequisite fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* macForkDatabase;
      yield* sql`ALTER TABLE projection_threads DROP COLUMN branch_pull_request_json`;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        before,
      );
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isFalse(columns.some((column) => column.name === "branch_pull_request_json"));
      assert.lengthOf(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 't3_fork_migration_history'`,
        0,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

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
      assert.lengthOf(yield* sql`SELECT * FROM t3_fork_migration_history`, 15);
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
