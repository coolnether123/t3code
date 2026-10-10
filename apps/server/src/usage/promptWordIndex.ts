import { UsageDay, type UsageReportInput, type UsageReportPrompts } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { isFrequentPromptWord, normalizePromptKeyword, promptWords } from "./promptWords.ts";
import { promptUsageTimeBounds } from "./usagePromptReport.ts";
import { promptIndexCutoverEnabled, localPromptFallbackActive } from "./promptSubscriberState.ts";

const MAX_MESSAGE_CHARACTERS = 262144;
const BATCH_MESSAGES = 32;

/** Each committed message is its own durable checkpoint. Parsing holds no write lease. */
export const warmPromptWordIndexBatch = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const pending = yield* sql<{ messageId: string; generation: number }>`
      SELECT message_id AS messageId, generation FROM usage_prompt_pending_v1
      ORDER BY rowid LIMIT ${BATCH_MESSAGES}`;
    let processed = 0;
    let characters = 0;
    for (const item of pending) {
      if (
        processed > 0 &&
        (characters >= 1024 * 1024 || (yield* Clock.currentTimeMillis) - started >= 50)
      )
        break;
      const row = (yield* sql<{
        messageId: string;
        threadId: string;
        createdAt: string;
        text: string;
        characters: number;
        generation: number;
      }>`SELECT m.message_id AS messageId, m.thread_id AS threadId, m.created_at AS createdAt,
      substr(m.text, 1, ${MAX_MESSAGE_CHARACTERS}) AS text, length(m.text) AS characters,
      q.generation AS generation
      FROM usage_prompt_pending_v1 q JOIN projection_thread_messages m ON m.message_id = q.message_id
      WHERE q.message_id = ${item.messageId} AND q.generation = ${item.generation}`)[0];
      if (row === undefined) continue;
      if (
        processed > 0 &&
        (characters + row.text.length > 1024 * 1024 ||
          (yield* Clock.currentTimeMillis) - started >= 50)
      )
        break;
      characters += row.text.length;
      const complete = Array.from(row.text).length === row.characters;
      const words = complete ? promptWords(row.text) : [];
      const terms = new Map<string, number>();
      for (const word of words) {
        if (word.length <= 64) terms.set(word, (terms.get(word) ?? 0) + 1);
      }
      const entries = [...terms].map(([word, occurrences]) => ({
        message_id: row.messageId,
        word,
        occurrences,
        frequent: isFrequentPromptWord(word) ? 1 : 0,
      }));
      const committed = yield* sql.withTransaction(
        Effect.gen(function* () {
          return yield* Effect.acquireUseRelease(
            Effect.gen(function* () {
              const timeout = (yield* sql<{ timeout: number }>`PRAGMA busy_timeout`)[0]!.timeout;
              yield* sql`PRAGMA busy_timeout = 0`;
              return timeout;
            }),
            () =>
              Effect.gen(function* () {
                // An edit or delete during parsing must not publish stale counts. This also
                // handles delete/reinsert identity reuse without trusting updated_at.
                const current = yield* sql`SELECT 1 FROM usage_prompt_pending_v1 q
          JOIN projection_thread_messages m ON m.message_id = q.message_id
          WHERE q.message_id = ${row.messageId} AND q.generation = ${row.generation}
            AND m.role = 'user' AND m.thread_id = ${row.threadId} AND m.created_at = ${row.createdAt}
            AND length(m.text) = ${row.characters}
            AND substr(m.text, 1, ${MAX_MESSAGE_CHARACTERS}) = ${row.text}`;
                if (current.length === 0) return false;
                yield* sql`INSERT INTO usage_prompt_words_v1 (message_id, thread_id, created_at, words, characters)
          VALUES (${row.messageId}, ${row.threadId}, ${row.createdAt}, ${complete ? words.length : null}, ${row.characters})`;
                for (let offset = 0; offset < entries.length; offset += 200) {
                  yield* sql`INSERT INTO usage_prompt_terms_v1 ${sql.insert(entries.slice(offset, offset + 200))}`;
                }
                yield* sql`DELETE FROM usage_prompt_pending_v1 WHERE message_id = ${row.messageId}`;
                return true;
              }),
            (timeout) => sql.unsafe(`PRAGMA busy_timeout = ${timeout}`),
          );
        }),
      );
      if (committed) processed++;
    }
    return processed;
  });

/** One service-scoped worker resumes persisted pending IDs after every restart. */
export const runPromptWordIndexer = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    while (true) {
      if (promptIndexCutoverEnabled() && !(yield* localPromptFallbackActive)) {
        yield* Effect.sleep(1000);
        continue;
      }
      const processed = yield* warmPromptWordIndexBatch(sql).pipe(
        Effect.catchCause(() => Effect.succeed(0)),
      );
      // Yield to projection writers and readers, and retry lock contention later.
      yield* Effect.sleep(processed > 0 ? 50 : 1000);
    }
  });

/** Read only committed counts. A cold request never builds its own index. */
export const readPromptWordIndex = (
  sql: SqlClient.SqlClient,
  input: UsageReportInput,
  readAt: string,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const { sinceTime, untilTime } = promptUsageTimeBounds(input);
      const keyword =
        input.keyword === undefined ? undefined : normalizePromptKeyword(input.keyword);
      const source = yield* sql<{ prompts: number }>`SELECT count(*) AS prompts
      FROM projection_thread_messages WHERE role = 'user'
        AND created_at >= ${sinceTime} AND created_at < ${untilTime}`;
      const totals = (yield* sql<{
        prompts: number;
        words: number;
        characters: number;
        threads: number;
        truncated: number;
      }>`SELECT count(*) AS prompts, coalesce(sum(words), 0) AS words,
      coalesce(sum(characters), 0) AS characters, count(DISTINCT thread_id) AS threads,
      coalesce(sum(words IS NULL), 0) AS truncated FROM usage_prompt_words_v1
      WHERE created_at >= ${sinceTime} AND created_at < ${untilTime}`)[0]!;
      const daily = new Map<string, { prompts: number; words: number }>();
      // At most 366 indexed range sums, without hydrating message timestamps.
      for (
        let dayTime = Date.parse(input.sinceDay);
        dayTime <= Date.parse(input.untilDay);
        dayTime += 86400000
      ) {
        const day = UsageDay.make(DateTime.formatIso(DateTime.makeUnsafe(dayTime)).slice(0, 10));
        const bounds = promptUsageTimeBounds({ ...input, sinceDay: day, untilDay: day });
        if (bounds.sinceTime >= bounds.untilTime) continue;
        const row = (yield* sql<{ prompts: number; words: number }>`SELECT count(*) AS prompts,
        coalesce(sum(words), 0) AS words FROM usage_prompt_words_v1
        WHERE created_at >= ${bounds.sinceTime} AND created_at < ${bounds.untilTime}`)[0]!;
        if (row.prompts) daily.set(day, row);
      }
      const vocabulary = (yield* sql<{ words: number }>`SELECT count(DISTINCT t.word) AS words
      FROM usage_prompt_terms_v1 t JOIN usage_prompt_words_v1 w ON w.message_id = t.message_id
      WHERE w.created_at >= ${sinceTime} AND w.created_at < ${untilTime} AND t.frequent = 1`)[0]!
        .words;
      const ranked = yield* sql<{
        word: string;
        count: number;
      }>`SELECT t.word, sum(t.occurrences) AS count
      FROM usage_prompt_terms_v1 t JOIN usage_prompt_words_v1 w ON w.message_id = t.message_id
      WHERE w.created_at >= ${sinceTime} AND w.created_at < ${untilTime} AND t.frequent = 1
      GROUP BY t.word ORDER BY count DESC, t.word LIMIT ${input.limit ?? 20}`;
      const search =
        keyword === undefined
          ? undefined
          : (yield* sql<{ count: number; prompts: number }>`
      SELECT coalesce(sum(t.occurrences), 0) AS count, count(*) AS prompts
      FROM usage_prompt_terms_v1 t JOIN usage_prompt_words_v1 w ON w.message_id = t.message_id
      WHERE t.word = ${keyword} AND w.created_at >= ${sinceTime} AND w.created_at < ${untilTime}`)[0]!;
      const reasons = [];
      if (totals.prompts < source[0]!.prompts) reasons.push("index-warming");
      if (totals.truncated > 0) reasons.push("message-text-limit");
      const report: UsageReportPrompts = {
        contractVersion: 1,
        mode: "prompts",
        readAt,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
        scope: "t3UserMessages",
        coverage: {
          status: reasons.length ? "partial" : "complete",
          examinedMessages: totals.prompts,
          countedMessages: totals.prompts,
          sourceMessages: source[0]!.prompts,
          truncatedMessages: totals.truncated,
          reasons,
        },
        totals: {
          prompts: totals.prompts,
          words: totals.words,
          characters: totals.characters,
          threads: totals.threads,
          activeDays: daily.size,
          averageWordsPerPrompt:
            reasons.length || !totals.prompts ? null : totals.words / totals.prompts,
        },
        daily: [...daily]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, value]) => ({ day: UsageDay.make(day), ...value })),
        words: ranked,
        countedDistinctWords: vocabulary,
        wordsTruncated: vocabulary > ranked.length,
        ...(search === undefined ? {} : { keyword: { word: keyword!, ...search } }),
        countingPolicy:
          "Stored T3 user-message IDs only; not an author-verified personal archive. " +
          "Assistant/tool/system text and attachment contents are excluded. Inline quotations and pasted text count. " +
          "Mirrors reusing an ID count once; identical text with different IDs counts separately, including voice copies and retries without shared provenance. " +
          "Words are NFKC-normalized Unicode letter/number runs with combining marks; punctuation splits words, emoji do not count. " +
          "Keyword search is a lowercase whole-word match, includes stopwords and digits, and uses the same normalization as totals. " +
          "Frequent words omit common English words, digit-bearing runs and runs outside 2–64 UTF-16 units. " +
          "Characters count Unicode code points. Counts are not tokens or estimates. Local days are inclusive; exact instants are half-open. " +
          "Rebuildable index unicode-runs-nfkc-v1; partial means unindexed or oversized messages, not complete history. Import omissions are unknown.",
      };
      return report;
    }),
  );
