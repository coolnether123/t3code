import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageDay } from "./usage.ts";

/** Otis report v1. Additive fields are accepted, unsupported major/policy are not. */
export const OtisPromptReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  authority: Schema.Literal("Otis:usage-analytics"),
  sourceId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  countingPolicy: Schema.Literal("unicode-runs-nfkc-v1"),
  readAt: Schema.String,
  window: Schema.Struct({
    sinceDay: UsageDay,
    untilDay: UsageDay,
    timeZone: Schema.String,
    sinceTime: Schema.String,
    untilTime: Schema.String,
  }),
  status: Schema.Literals(["available", "partial", "unavailable"]),
  freshness: Schema.Struct({
    status: Schema.Literals(["current", "stale", "unavailable"]),
    sourceObservedAt: Schema.NullOr(Schema.String),
    ageMs: Schema.NullOr(NonNegativeInt),
    revision: Schema.NullOr(NonNegativeInt),
  }),
  coverage: Schema.Struct({
    status: Schema.Literals(["complete", "partial", "missing"]),
    examinedMessages: Schema.NullOr(NonNegativeInt),
    countedMessages: Schema.NullOr(NonNegativeInt),
    sourceMessages: Schema.NullOr(NonNegativeInt),
    truncatedMessages: Schema.NullOr(NonNegativeInt),
    reasons: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
  }),
  totals: Schema.NullOr(
    Schema.Struct({
      prompts: NonNegativeInt,
      words: NonNegativeInt,
      characters: NonNegativeInt,
      threads: NonNegativeInt,
      activeDays: NonNegativeInt,
      averageWordsPerPrompt: Schema.NullOr(Schema.Number),
    }),
  ),
  words: Schema.Array(
    Schema.Struct({ word: Schema.String.check(Schema.isMaxLength(64)), count: NonNegativeInt }),
  ).check(Schema.isMaxLength(200)),
  daily: Schema.Array(
    Schema.Struct({ day: UsageDay, prompts: NonNegativeInt, words: NonNegativeInt }),
  ).check(Schema.isMaxLength(366)),
  keyword: Schema.optional(
    Schema.Struct({ word: Schema.String, count: NonNegativeInt, prompts: NonNegativeInt }),
  ),
  countedDistinctWords: Schema.NullOr(NonNegativeInt),
  wordsTruncated: Schema.NullOr(Schema.Boolean),
});
export type OtisPromptReport = typeof OtisPromptReport.Type;
