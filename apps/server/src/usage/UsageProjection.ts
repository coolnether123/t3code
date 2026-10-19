import { setupUsagePromptIndex } from "./usagePromptIndexSetup.ts";
import { UsageReadError, type UsageReportInput, type UsageReportPrompts } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { PromptUsageMessage } from "./usagePromptReport.ts";
import { readPromptWordIndex, runPromptWordIndexer } from "./promptWordIndex.ts";

export class UsageProjection extends Context.Service<
  UsageProjection,
  {
    readonly getSnapshotSequence: () => Effect.Effect<
      { readonly snapshotSequence: number },
      UsageReadError
    >;
    readonly listPromptUsageMessages?: (input: {
      readonly sinceTime: string;
      readonly untilTime: string;
      readonly beforeCreatedAt: string;
      readonly beforeMessageId: string;
    }) => Effect.Effect<readonly PromptUsageMessage[], UsageReadError>;
    readonly readPromptWordIndex?: (
      input: UsageReportInput,
      readAt: string,
    ) => Effect.Effect<UsageReportPrompts, UsageReadError>;
    readonly findThreadMappingsByProviderSessionIds?: (ids: readonly string[]) => Effect.Effect<
      readonly {
        readonly threadId: string;
        readonly threadCount: number;
        readonly providerName: string | null;
        readonly providerSessionId: string;
      }[],
      UsageReadError
    >;
  }
>()("t3/usage/UsageProjection") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failure = (cause: unknown) =>
    new UsageReadError({
      reason: "scanFailed",
      detail: "Usage projections could not be read.",
      cause,
    });
  // This view keeps the existing derived index on V2's authoritative messages.
  yield* sql`CREATE VIEW IF NOT EXISTS usage_prompt_messages_v2 AS
    SELECT message_id, thread_id, role, created_at, updated_at,
      coalesce(json_extract(payload_json, '$.text'), '') AS text
    FROM orchestration_v2_projection_messages
    WHERE json_extract(payload_json, '$.notification') IS NULL`.pipe(Effect.mapError(failure));
  yield* setupUsagePromptIndex.pipe(Effect.mapError(failure));
  yield* Effect.forkScoped(runPromptWordIndexer(sql, "usage_prompt_messages_v2"));
  return UsageProjection.of({
    getSnapshotSequence: () =>
      sql<{ snapshotSequence: number }>`
      SELECT coalesce(max(sequence), 0) AS snapshotSequence FROM orchestration_events`.pipe(
        Effect.map((rows) => rows[0] ?? { snapshotSequence: 0 }),
        Effect.mapError(failure),
      ),
    listPromptUsageMessages: (input) =>
      sql<PromptUsageMessage>`
      SELECT message_id AS messageId, thread_id AS threadId, created_at AS createdAt,
        substr(text, 1, 262144) AS text, length(text) AS textLength
      FROM usage_prompt_messages_v2
      WHERE role = 'user' AND created_at >= ${input.sinceTime} AND created_at < ${input.untilTime}
        AND (created_at < ${input.beforeCreatedAt} OR
          (created_at = ${input.beforeCreatedAt} AND message_id < ${input.beforeMessageId}))
      ORDER BY created_at DESC, message_id DESC LIMIT 32`.pipe(Effect.mapError(failure)),
    readPromptWordIndex: (input, readAt) =>
      readPromptWordIndex(sql, input, readAt, "usage_prompt_messages_v2").pipe(
        Effect.mapError(failure),
      ),
    findThreadMappingsByProviderSessionIds: (ids) =>
      ids.length === 0
        ? Effect.succeed([])
        : sql<{
            threadId: string;
            threadCount: number;
            providerName: string;
            providerSessionId: string;
          }>`WITH native AS (
      SELECT DISTINCT thread_id AS threadId, driver AS providerName,
        json_extract(payload_json, '$.nativeThreadRef.nativeId') AS providerSessionId
      FROM orchestration_v2_projection_provider_threads
      WHERE thread_id IS NOT NULL AND json_extract(payload_json, '$.nativeThreadRef.strength') = 'strong' AND json_extract(payload_json, '$.nativeThreadRef.nativeId') IN ${sql.in(ids)}
    ) SELECT threadId, providerName, providerSessionId,
      count(*) OVER (PARTITION BY providerName, providerSessionId) AS threadCount FROM native`.pipe(
            Effect.mapError(failure),
          ),
  });
});

export const layer = Layer.effect(UsageProjection, make);
