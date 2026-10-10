// @effect-diagnostics nodeBuiltinImport:off - closed SQLite backup fixtures use native files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodePerfHooks from "node:perf_hooks";
import { UsageDay } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/055_PromptWordIndex.ts";
import {
  readPromptWordIndex,
  warmPromptWordIndexBatch,
  runPromptWordIndexer,
} from "./promptWordIndex.ts";

const input = {
  mode: "prompts" as const,
  sinceDay: UsageDay.make("2026-10-09"),
  untilDay: UsageDay.make("2026-10-09"),
  timeZone: "UTC",
  keyword: "build",
};
const now = "2026-10-09T12:00:00.000Z";
const createSource = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE projection_thread_messages (
    message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
    text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
    yield* sql`CREATE INDEX idx_projection_user_messages_created_id
    ON projection_thread_messages(created_at, message_id) WHERE role = 'user'`;
  });
const fixtureDirectory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "synthetic-prompt-index-"))),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);

it.effect(
  "cold live-scale synthetic history returns progress without indexing and survives restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixtureDirectory;
        const filename = NodePath.join(directory, "synthetic.sqlite");
        const layer = NodeSqliteClient.layer({ filename });
        const checkpoint = yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA journal_mode = WAL`;
            yield* createSource(sql);
            // The cold migration queues old rows but never parses their prompt bodies.
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`WITH RECURSIVE ids(n) AS (
          SELECT 0 UNION ALL SELECT n + 1 FROM ids WHERE n < 356677
        ) INSERT INTO projection_thread_messages
          SELECT 'synthetic-' || n, 'thread-' || (n % 2009),
            CASE WHEN n < 5001 THEN 'user' ELSE 'assistant' END,
            'build build the', ${now}, ${now} FROM ids`;
              }),
            );
            yield* migration;
            const started = NodePerfHooks.performance.now();
            const cold = yield* readPromptWordIndex(sql, input, now);
            const coldMs = NodePerfHooks.performance.now() - started;
            assert.strictEqual(cold.coverage.status, "partial");
            assert.strictEqual(cold.coverage.sourceMessages, 5001);
            assert.strictEqual(cold.coverage.examinedMessages, 0);
            assert.strictEqual(cold.keyword?.count, 0);
            assert.isNull(cold.totals.averageWordsPerPrompt);
            assert.isBelow(coldMs, 3000);
            const pending = (yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM usage_prompt_pending_v1`)[0]!.count;
            assert.strictEqual(pending, 5001);
            const processed = yield* warmPromptWordIndexBatch(sql);
            assert.isAbove(processed, 0);
            assert.isAtMost(processed, 32);
            const partial = yield* readPromptWordIndex(sql, input, now);
            assert.strictEqual(partial.coverage.examinedMessages, processed);
            assert.strictEqual(partial.keyword?.count, processed * 2);
            yield* Effect.logInfo(
              `Synthetic 356678-message cold read: ${coldMs.toFixed(1)} ms; checkpoint: ${processed} prompts`,
            );
            return processed;
          }).pipe(Effect.provide(layer)),
        );

        // All handles closed. A new client has no in-memory cursor or prior worker.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`PRAGMA journal_mode = WAL`;
            const reopened = yield* readPromptWordIndex(sql, input, now);
            assert.strictEqual(reopened.coverage.examinedMessages, checkpoint);
            while ((yield* warmPromptWordIndexBatch(sql)) > 0) {
              /* Drain persisted work. */
            }
            const started = NodePerfHooks.performance.now();
            const complete = yield* readPromptWordIndex(sql, input, now);
            assert.strictEqual(complete.coverage.status, "complete");
            assert.strictEqual(complete.totals.prompts, 5001);
            assert.strictEqual(complete.totals.words, 15003);
            assert.strictEqual(complete.keyword?.count, 10002);
            assert.strictEqual(complete.daily[0]?.words, 15003);
            assert.deepStrictEqual(complete.words, [{ word: "build", count: 10002 }]);
            assert.isBelow(NodePerfHooks.performance.now() - started, 3000);
            assert.strictEqual(yield* warmPromptWordIndexBatch(sql), 0);
            assert.strictEqual(
              (yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM projection_thread_messages`)[0]!.count,
              356678,
            );
            assert.strictEqual(
              (yield* sql<{ integrity_check: string }>`PRAGMA integrity_check`)[0]!.integrity_check,
              "ok",
            );
          }).pipe(Effect.provide(layer)),
        );
      }),
    ),
  { timeout: 60000 },
);

it.effect(
  "external write contention leaves the checkpoint readable and retries pending messages",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fixtureDirectory;
        const filename = NodePath.join(directory, "synthetic.sqlite");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* createSource(sql);
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`PRAGMA busy_timeout = 5000`;
          yield* migration;
          yield* sql`INSERT INTO projection_thread_messages VALUES ('first', 'thread', 'user', 'build', ${now}, ${now})`;
          yield* warmPromptWordIndexBatch(sql);
          yield* sql`INSERT INTO projection_thread_messages VALUES ('second', 'thread', 'user', 'build build', ${now}, ${now})`;
          const blocker = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
            (db) => Effect.sync(() => db.close()),
          );
          blocker.exec("BEGIN IMMEDIATE");
          yield* Effect.gen(function* () {
            const started = NodePerfHooks.performance.now();
            assert.isTrue(Exit.isFailure(yield* Effect.exit(warmPromptWordIndexBatch(sql))));
            assert.isBelow(NodePerfHooks.performance.now() - started, 1000);
            assert.strictEqual(
              (yield* sql<{ timeout: number }>`PRAGMA busy_timeout`)[0]!.timeout,
              5000,
            );
            const partial = yield* readPromptWordIndex(sql, input, now);
            assert.strictEqual(partial.coverage.status, "partial");
            assert.strictEqual(partial.keyword?.count, 1);
            assert.strictEqual(partial.coverage.sourceMessages, 2);
          }).pipe(Effect.ensuring(Effect.sync(() => blocker.exec("ROLLBACK"))));
          assert.strictEqual(yield* warmPromptWordIndexBatch(sql), 1);
          const complete = yield* readPromptWordIndex(sql, input, now);
          assert.strictEqual(complete.coverage.status, "complete");
          assert.strictEqual(complete.keyword?.count, 3);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      }),
    ),
);

it.effect("the background worker progresses without reads and is interrupted with its scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createSource(sql);
      yield* migration;
      yield* sql`WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n < 64)
      INSERT INTO projection_thread_messages SELECT 'synthetic-' || n, 'thread', 'user', 'build', ${now}, ${now} FROM ids`;
      const worker = yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(runPromptWordIndexer(sql));
          // Synthetic clock drains sleeping batches. No request wakes or owns the worker.
          while (
            (yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM usage_prompt_pending_v1`)[0]!.count > 0
          ) {
            yield* TestClock.adjust(1000);
          }
          assert.strictEqual(
            (yield* sql<{ count: number }>`SELECT count(*) AS count FROM usage_prompt_words_v1`)[0]!
              .count,
            65,
          );
          return fiber;
        }),
      );
      assert.isTrue(Exit.isFailure(yield* Fiber.await(worker)));
      assert.strictEqual((yield* readPromptWordIndex(sql, input, now)).keyword?.count, 65);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  ),
);

it.effect("migration is additive and a pre-migration backup remains restorable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fixtureDirectory;
      const filename = NodePath.join(directory, "synthetic.sqlite");
      const backup = NodePath.join(directory, "synthetic-backup.sqlite");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* createSource(sql);
          yield* sql`INSERT INTO projection_thread_messages VALUES ('source', 'thread', 'user', 'build', ${now}, ${now})`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
      );
      NodeFS.copyFileSync(filename, backup);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* migration;
          yield* warmPromptWordIndexBatch(sql);
          assert.strictEqual((yield* readPromptWordIndex(sql, input, now)).totals.words, 1);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
      );
      // Restore only this disposable, closed fixture, never the live T3 home.
      NodeFS.copyFileSync(backup, filename);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.strictEqual(
            (yield* sql<{ text: string }>`SELECT text FROM projection_thread_messages`)[0]!.text,
            "build",
          );
          assert.strictEqual(
            (yield* sql`SELECT name FROM sqlite_master WHERE name = 'usage_prompt_words_v1'`)
              .length,
            0,
          );
          yield* migration;
          assert.strictEqual(
            (yield* readPromptWordIndex(sql, input, now)).coverage.sourceMessages,
            1,
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
      );
    }),
  ),
);

it.effect(
  "a failed message rolls back its terms and queue removal without losing earlier checkpoints",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createSource(sql);
      yield* migration;
      yield* sql`PRAGMA busy_timeout = 5000`;
      yield* sql`INSERT INTO projection_thread_messages VALUES
      ('good', 'thread', 'user', 'build', ${now}, ${now}),
      ('bad', 'thread', 'user', 'build build', ${now}, ${now})`;
      yield* sql`CREATE TRIGGER synthetic_failed_message BEFORE INSERT ON usage_prompt_terms_v1
      WHEN NEW.message_id = 'bad' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(warmPromptWordIndexBatch(sql))));
      assert.strictEqual((yield* sql<{ timeout: number }>`PRAGMA busy_timeout`)[0]!.timeout, 5000);
      const partial = yield* readPromptWordIndex(sql, input, now);
      assert.strictEqual(partial.totals.prompts, 1);
      assert.strictEqual(partial.keyword?.count, 1);
      assert.deepStrictEqual(yield* sql`SELECT message_id FROM usage_prompt_pending_v1`, [
        { message_id: "bad" },
      ]);
      yield* sql`DROP TRIGGER synthetic_failed_message`;
      assert.strictEqual(yield* warmPromptWordIndexBatch(sql), 1);
      assert.strictEqual((yield* readPromptWordIndex(sql, input, now)).keyword?.count, 3);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
