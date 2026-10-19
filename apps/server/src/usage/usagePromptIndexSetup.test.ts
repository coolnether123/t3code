import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { UsageDay } from "@t3tools/contracts";
import { setupUsagePromptIndex } from "./usagePromptIndexSetup.ts";
import { readPromptWordIndex, warmPromptWordIndexBatch } from "./promptWordIndex.ts";

it.layer(NodeSqliteClient.layerMemory())("V2 prompt word index", (it) => {
  it.effect("indexes real prompts and updates or deletes their derived words", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_messages (
      message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, created_at TEXT, updated_at TEXT, payload_json TEXT)`;
      yield* sql`CREATE VIEW usage_prompt_messages_v2 AS SELECT message_id, thread_id, role, created_at, updated_at,
      json_extract(payload_json, '$.text') AS text FROM orchestration_v2_projection_messages
      WHERE json_extract(payload_json, '$.notification') IS NULL`;
      yield* setupUsagePromptIndex;
      yield* setupUsagePromptIndex;
      const at = "2026-10-19T06:00:00.000Z";
      yield* sql`INSERT INTO orchestration_v2_projection_messages VALUES ('prompt', 'thread', 'user', ${at}, ${at}, '{"text":"build build"}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages VALUES ('notice', 'thread', 'user', ${at}, ${at}, '{"text":"private notice", "notification":{"summary":"notice"}}')`;
      assert.strictEqual(yield* warmPromptWordIndexBatch(sql, "usage_prompt_messages_v2"), 1);
      const input = {
        mode: "prompts" as const,
        sinceDay: UsageDay.make("2026-10-19"),
        untilDay: UsageDay.make("2026-10-19"),
        timeZone: "UTC",
      };
      const report = yield* readPromptWordIndex(sql, input, at, "usage_prompt_messages_v2");
      assert.strictEqual(report.totals.prompts, 1);
      assert.strictEqual(report.totals.words, 2);
      yield* setupUsagePromptIndex;
      assert.strictEqual(
        (yield* readPromptWordIndex(sql, input, at, "usage_prompt_messages_v2")).totals.words,
        2,
      );
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{"text":"updated"}' WHERE message_id = 'prompt'`;
      assert.strictEqual(yield* warmPromptWordIndexBatch(sql, "usage_prompt_messages_v2"), 1);
      assert.strictEqual(
        (yield* readPromptWordIndex(sql, input, at, "usage_prompt_messages_v2")).totals.words,
        1,
      );
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'prompt'`;
      assert.strictEqual(
        (yield* readPromptWordIndex(sql, input, at, "usage_prompt_messages_v2")).totals.prompts,
        0,
      );
    }),
  );
});
