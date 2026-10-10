import { UsageDay, UsageReport, type UsageReportInput } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/055_PromptWordIndex.ts";
import { readPromptWordIndex, warmPromptWordIndexBatch } from "./promptWordIndex.ts";
import { normalizePromptKeyword, promptWords } from "./promptWords.ts";

const input: UsageReportInput = {
  mode: "prompts",
  sinceDay: UsageDay.make("2026-10-09"),
  untilDay: UsageDay.make("2026-10-09"),
  timeZone: "UTC",
};
const now = "2026-10-09T13:00:00.000Z";
const readIndexed = (sql: SqlClient.SqlClient, query: UsageReportInput, at: string) =>
  Effect.gen(function* () {
    while ((yield* warmPromptWordIndexBatch(sql)) > 0) {
      /* Drain synthetic fixture. */
    }
    return yield* readPromptWordIndex(sql, query, at);
  });
const decodeReport = Schema.decodeUnknownEffect(UsageReport);
const layer = it.layer(NodeSqliteClient.layerMemory());

layer("derived prompt word index", (it) => {
  it.effect(
    "warms incrementally beyond the old scan cap, queries all indexed words and rebuilds",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, text TEXT,
      created_at TEXT, updated_at TEXT)`;
        yield* migration;
        yield* sql`PRAGMA foreign_keys = ON`;
        const insert = (id: string, text: string, role = "user", at = "2026-10-09T12:00:00.000Z") =>
          sql`INSERT INTO projection_thread_messages VALUES (${id}, 'thread', ${role}, ${text}, ${at}, ${at})`;
        yield* insert("voice-identity", "Caf\u00e9 cafe\u0301 BUILD build the 123 \ud83d\ude00");
        // A mirror with the same durable ID cannot be another source row.
        yield* sql`INSERT OR IGNORE INTO projection_thread_messages VALUES
      ('voice-identity', 'thread', 'user', 'Caf\u00e9 cafe\u0301 BUILD build the 123 \ud83d\ude00', ${now}, ${now})`;
        yield* insert("real-repeat", "Caf\u00e9 cafe\u0301 BUILD build the 123 \ud83d\ude00");
        yield* insert("assistant", "assistant hidden words", "assistant");
        yield* insert("tool", "tool hidden words", "tool");
        yield* insert("before", "before", "user", "2026-10-08T23:59:59.999Z");
        yield* insert("after", "after", "user", "2026-10-10T00:00:00.000Z");
        yield* insert("multiline", "first\nsecond\tthird");
        const initial = yield* readIndexed(sql, { ...input, keyword: "CAF\u00c9" }, now);
        assert.strictEqual(initial.totals.words, 15);
        assert.deepStrictEqual(initial.keyword, { word: "caf\u00e9", count: 4, prompts: 2 });
        assert.strictEqual(initial.coverage.status, "complete");
        assert.deepStrictEqual(yield* decodeReport(initial), initial);
        const common = yield* readIndexed(sql, { ...input, keyword: "the" }, now);
        assert.strictEqual(common.keyword?.count, 2);
        const digits = yield* readIndexed(sql, { ...input, keyword: "123" }, now);
        assert.strictEqual(digits.keyword?.count, 2);
        assert.isFalse(initial.words.some((row) => /hidden|assistant|tool|123|the/.test(row.word)));
        assert.strictEqual(promptWords("\u{10400}\u{10428} cafe\u0301 \u{1f600}").length, 2);
        assert.throws(() => normalizePromptKeyword("build OR secret"));
        assert.throws(() => normalizePromptKeyword("' OR 1=1 --"));
        // Trigger invalidation observes an edit even with unchanged updated_at.
        yield* sql`UPDATE projection_thread_messages SET text = 'changed changed' WHERE message_id = 'voice-identity'`;
        yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'real-repeat'`;
        const edited = yield* readIndexed(sql, { ...input, keyword: "caf\u00e9" }, now);
        assert.strictEqual(edited.keyword?.count, 0);
        assert.strictEqual(edited.totals.words, 5);
        yield* sql`UPDATE projection_thread_messages SET role = 'assistant' WHERE message_id = 'multiline'`;
        assert.strictEqual((yield* readIndexed(sql, input, now)).totals.words, 2);
        // Raw authoritative history survives deletion of every derived row.
        yield* sql`DELETE FROM usage_prompt_terms_v1`;
        yield* sql`DELETE FROM usage_prompt_words_v1`;
        yield* sql`INSERT INTO usage_prompt_pending_v1(message_id) SELECT message_id FROM projection_thread_messages WHERE role = 'user'`;
        assert.strictEqual((yield* readIndexed(sql, input, now)).totals.words, 2);
        yield* sql`DELETE FROM projection_thread_messages`;
        const many = Array.from({ length: 5001 }, (_, id) => ({
          message_id: `many-${id}`,
          thread_id: "thread",
          role: "user",
          text: "build the",
          created_at: "2026-10-09T12:00:00.000Z",
          updated_at: now,
        }));
        for (let offset = 0; offset < many.length; offset += 200)
          yield* sql`INSERT INTO projection_thread_messages ${sql.insert(many.slice(offset, offset + 200))}`;
        const warming = yield* readPromptWordIndex(sql, input, now);
        assert.include(warming.coverage.reasons, "index-warming");
        assert.isNull(warming.totals.averageWordsPerPrompt);
        let complete = warming;
        for (let batch = 0; batch < 160 && complete.coverage.status === "partial"; batch++)
          complete = yield* readIndexed(sql, { ...input, keyword: "the" }, now);
        assert.strictEqual(complete.coverage.status, "complete");
        assert.strictEqual(complete.totals.prompts, 5001);
        assert.strictEqual(complete.totals.words, 10002);
        assert.strictEqual(complete.keyword?.count, 5001);
        assert.strictEqual(complete.daily[0]?.words, 10002);
        const plan = yield* sql<{
          detail: string;
        }>`EXPLAIN QUERY PLAN SELECT * FROM usage_prompt_terms_v1 WHERE word = 'the'`;
        assert.isTrue(plan.some((row) => row.detail.includes("INDEX")));
        yield* sql`DELETE FROM projection_thread_messages`;
        const vocabularyWord = (value: number) => {
          let letters = "";
          do {
            letters += String.fromCharCode(97 + (value % 26));
            value = Math.floor(value / 26);
          } while (value);
          return `lex${letters}`;
        };
        for (let group = 0; group < 3; group++) {
          yield* insert(
            `vocabulary-${group}`,
            Array.from({ length: 20000 }, (_, index) => vocabularyWord(group * 20000 + index)).join(
              " ",
            ),
          );
        }
        const vocabulary = yield* readIndexed(
          sql,
          { ...input, keyword: vocabularyWord(59999) },
          now,
        );
        assert.strictEqual(vocabulary.countedDistinctWords, 60000);
        assert.strictEqual(vocabulary.keyword?.count, 1);
        assert.strictEqual(vocabulary.totals.words, 60000);
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* insert("long", "word ".repeat(7000));
        assert.strictEqual((yield* readIndexed(sql, input, now)).totals.words, 7000);
        yield* insert("oversized", "word ".repeat(60000));
        const partial = yield* readIndexed(sql, input, now);
        assert.strictEqual(partial.coverage.truncatedMessages, 1);
        assert.strictEqual(partial.coverage.status, "partial");
        assert.isNull(partial.totals.averageWordsPerPrompt);
        yield* sql`DELETE FROM projection_thread_messages`;
        const empty = yield* readIndexed(sql, input, now);
        assert.strictEqual(empty.coverage.status, "complete");
        assert.strictEqual(empty.totals.words, 0);
        // DST and exact end instants retain half-open boundaries.
        yield* insert("dst-start", "included", "user", "2026-03-08T06:00:00.000Z");
        yield* insert("dst-end", "excluded", "user", "2026-03-09T05:00:00.000Z");
        const dst = yield* readIndexed(
          sql,
          {
            ...input,
            timeZone: "America/Chicago",
            sinceDay: UsageDay.make("2026-03-08"),
            untilDay: UsageDay.make("2026-03-08"),
          },
          now,
        );
        assert.strictEqual(dst.totals.words, 1);
        assert.deepStrictEqual(dst.daily, [
          { day: UsageDay.make("2026-03-08"), prompts: 1, words: 1 },
        ]);
        const exact = yield* readIndexed(
          sql,
          {
            ...input,
            timeZone: "America/Chicago",
            sinceDay: UsageDay.make("2026-03-08"),
            untilDay: UsageDay.make("2026-03-08"),
            sinceTime: "2026-03-08T06:00:00Z",
            untilTime: "2026-03-08T06:00:01Z",
          },
          now,
        );
        assert.strictEqual(exact.totals.words, 1);
      }),
  );
});
