import { UsageDay, type UsageReportInput, type UsageReportPrompts } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { normalizePromptKeyword, promptWords, isFrequentPromptWord } from "./promptWords.ts";

export type PromptUsageMessage = {
  readonly messageId: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly textLength: number;
};

/** Counts persisted messages without retaining prompt text in the report. */
export class PromptUsageAccumulator {
  readonly reasons = new Set<string>();
  examinedMessages = 0;
  textCharacters = 0;
  private prompts = 0;
  private words = 0;
  private characters = 0;
  private truncatedMessages = 0;
  private keywordCount = 0;
  private keywordPrompts = 0;
  private readonly threads = new Set<string>();
  private readonly seenMessages = new Set<string>();
  private readonly vocabulary = new Map<string, number>();
  private readonly daily = new Map<string, { prompts: number; words: number }>();
  private readonly formatDay: Intl.DateTimeFormat;
  private readonly input: UsageReportInput;

  constructor(input: UsageReportInput) {
    this.input = input;
    this.formatDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: input.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }

  add(message: PromptUsageMessage): void {
    this.examinedMessages++;
    this.textCharacters += message.text.length;
    if (this.seenMessages.has(message.messageId)) {
      this.reasons.add("concurrent-message-change");
      return;
    }
    this.seenMessages.add(message.messageId);
    const timestamp = Date.parse(message.createdAt);
    if (!Number.isFinite(timestamp)) {
      this.reasons.add("invalid-message-time");
      return;
    }
    const day = this.formatDay.format(timestamp);
    if (
      day < this.input.sinceDay ||
      day > this.input.untilDay ||
      (this.input.sinceTime !== undefined && timestamp < Date.parse(this.input.sinceTime)) ||
      (this.input.untilTime !== undefined && timestamp >= Date.parse(this.input.untilTime))
    )
      return;
    this.prompts++;
    this.characters += message.textLength;
    this.threads.add(message.threadId);
    const daily = this.daily.get(day) ?? { prompts: 0, words: 0 };
    daily.prompts++;
    this.daily.set(day, daily);
    if (Array.from(message.text).length < message.textLength) {
      this.truncatedMessages++;
      this.reasons.add("message-text-limit");
      return;
    }
    const keyword =
      this.input.keyword === undefined ? undefined : normalizePromptKeyword(this.input.keyword);
    let matched = false;
    for (const word of promptWords(message.text)) {
      this.words++;
      daily.words++;
      if (word === keyword) {
        this.keywordCount++;
        matched = true;
      }
      if (!isFrequentPromptWord(word)) continue;
      if (this.vocabulary.has(word) || this.vocabulary.size < 50_000) {
        this.vocabulary.set(word, (this.vocabulary.get(word) ?? 0) + 1);
      } else {
        this.reasons.add("vocabulary-limit");
      }
    }
    if (matched) this.keywordPrompts++;
  }

  report(readAt: string, missing = false): UsageReportPrompts {
    const limit = this.input.limit ?? 20;
    const words = [...this.vocabulary].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      contractVersion: 1,
      mode: "prompts",
      readAt,
      sinceDay: this.input.sinceDay,
      untilDay: this.input.untilDay,
      timeZone: this.input.timeZone,
      scope: "t3UserMessages",
      coverage: {
        status: missing ? "missing" : this.reasons.size > 0 ? "partial" : "complete",
        examinedMessages: this.examinedMessages,
        countedMessages: this.prompts,
        truncatedMessages: this.truncatedMessages,
        reasons: [...this.reasons].sort(),
      },
      totals: {
        prompts: this.prompts,
        words: this.words,
        characters: this.characters,
        threads: this.threads.size,
        activeDays: this.daily.size,
        averageWordsPerPrompt:
          this.prompts === 0 || this.reasons.size > 0 ? null : this.words / this.prompts,
      },
      daily: [...this.daily]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, totals]) => ({
          day: UsageDay.make(day),
          ...totals,
        })),
      words: words.slice(0, limit).map(([word, count]) => ({ word, count })),
      countedDistinctWords: words.length,
      ...(this.input.keyword === undefined || missing
        ? {}
        : {
            keyword: {
              word: normalizePromptKeyword(this.input.keyword),
              count: this.keywordCount,
              prompts: this.keywordPrompts,
            },
          }),
      wordsTruncated: words.length > limit || this.reasons.has("vocabulary-limit"),
      countingPolicy:
        "One persisted T3 user-message ID is one prompt, including imports and archived chats. Copies in separate T3 threads count separately. Attachment-only messages count as prompts; attachment contents, system instructions, tools and assistant text are excluded. Words are NFKC-normalized Unicode letter/number runs; characters are Unicode code points. Frequent words are lowercase, omit common English words and word runs containing digits, and are not token counts. Punctuation splits words, so gpt-4o contributes gpt. A changing projection or read limit makes totals best-effort partial observations, not complete usage.",
    };
  }
}

export function promptUsageTimeBounds(input: UsageReportInput) {
  const start = DateTime.makeZonedUnsafe(`${input.sinceDay}T00:00:00Z`, {
    timeZone: input.timeZone,
    adjustForTimeZone: true,
  });
  const end = DateTime.add(
    DateTime.makeZonedUnsafe(`${input.untilDay}T00:00:00Z`, {
      timeZone: input.timeZone,
      adjustForTimeZone: true,
    }),
    { days: 1 },
  );
  return {
    sinceTime: DateTime.formatIso(
      DateTime.makeUnsafe(
        Math.max(
          DateTime.toEpochMillis(start),
          input.sinceTime === undefined ? -Infinity : Date.parse(input.sinceTime),
        ),
      ),
    ),
    untilTime: DateTime.formatIso(
      DateTime.makeUnsafe(
        Math.min(
          DateTime.toEpochMillis(end),
          input.untilTime === undefined ? Infinity : Date.parse(input.untilTime),
        ),
      ),
    ),
  };
}

export function validatePromptUsageInput(input: UsageReportInput): void {
  if (input.keyword !== undefined) normalizePromptKeyword(input.keyword);
  const since = Date.parse(`${input.sinceDay}T00:00:00Z`);
  const until = Date.parse(`${input.untilDay}T00:00:00Z`);
  if (
    !Number.isFinite(since) ||
    !Number.isFinite(until) ||
    DateTime.formatIso(DateTime.makeUnsafe(since)).slice(0, 10) !== input.sinceDay ||
    DateTime.formatIso(DateTime.makeUnsafe(until)).slice(0, 10) !== input.untilDay ||
    until < since ||
    until - since > 365 * 86400000
  )
    throw new Error("Invalid prompt usage day window.");
  new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format(0);
  if (
    input.providers !== undefined ||
    input.runIds !== undefined ||
    input.quotaIntervals !== undefined ||
    input.resolution !== undefined
  )
    throw new Error("Prompt usage does not accept provider, run, quota or resolution filters.");
  if ((input.sinceTime === undefined) !== (input.untilTime === undefined))
    throw new Error("Both exact time bounds are required.");
  if (input.sinceTime !== undefined && input.untilTime !== undefined) {
    const start = Date.parse(input.sinceTime);
    const end = Date.parse(input.untilTime);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      end - start > 366 * 86400000 ||
      !/[Tt].*(Z|[+-]\d{2}:\d{2})$/.test(input.sinceTime) ||
      !/[Tt].*(Z|[+-]\d{2}:\d{2})$/.test(input.untilTime)
    )
      throw new Error("Invalid exact prompt usage window.");
  }
}
