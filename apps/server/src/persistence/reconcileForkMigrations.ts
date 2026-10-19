import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import AuthSessionClientConnection from "./Migrations/041_AuthSessionClientConnection.ts";
import LinkedPullRequest from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import ThreadPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";
import MessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import TitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import FilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

const forkNames = new Map([
  [41, "Workers"],
  [42, "AuthSessionClientConnection"],
  [50, "ProjectionThreadsActiveOrderKeyCompatibility"],
  [51, "ProjectionThreadContextCompactions"],
  [52, "BootstrapThreadContextCompactions"],
  [53, "PromptUsageMessageIndex"],
  [54, "UserMessageIdentityIndex"],
  [55, "PromptWordIndex"],
]);

const prerequisites = [
  [41, "AuthSessionClientConnection", AuthSessionClientConnection],
  [42, "ProjectionThreadLinkedPullRequest", LinkedPullRequest],
  [50, "ProjectionThreadPullRequests", ThreadPullRequests],
  [51, "ProjectionThreadMessageContext", MessageContext],
  [52, "ProjectionThreadTitleState", TitleState],
  [53, "PullRequestFilesViewed", FilesViewed],
  [54, "ProjectionThreadsAutoSettleDisabledAt", AutoSettleDisabledAt],
] as const;

// The fork shipped a different ledger through 55. Normalize only that known
// history, atomically, before the id-based migrator can skip V2's foundation.
export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      if (!tables.some((table) => table.name === "effect_sql_migrations")) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      if (!history.some((row) => row.migration_id === 41 && row.name === "Workers")) return [];
      const divergent = history.filter((row) => forkNames.has(row.migration_id));
      if (
        divergent.some((row) => forkNames.get(row.migration_id) !== row.name) ||
        history.some((row) => row.migration_id > 55) ||
        !history.some((row) => row.migration_id === 42 && row.name === "AuthSessionClientConnection") ||
        tables.some((table) => table.name === "orchestration_v2_events")
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade an unrecognized fork migration history. The database was left unchanged.",
        });
      }

      yield* sql`CREATE TABLE IF NOT EXISTS t3_fork_migration_history (
        migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL
      )`;
      for (const row of divergent) {
        yield* sql`INSERT INTO t3_fork_migration_history (migration_id, name)
          VALUES (${row.migration_id}, ${row.name})`;
      }
      // Workers and usage tables retain their data. Only ledger entries move;
      // missing upstream V1 columns are added before its V2 importer reads them.
      for (const [id, name, migrate] of prerequisites) {
        yield* migrate;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${id}`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
      }
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 55 AND name = 'PromptWordIndex'`;
      return prerequisites.map(([id, name]) => [id, name] as const);
    }),
  );
});
