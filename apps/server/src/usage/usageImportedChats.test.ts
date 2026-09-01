import { describe, expect, it } from "vite-plus/test";

import {
  estimateChatTokens,
  parseAiStudioExport,
  parseChatGptExport,
} from "./usageImportedChats.ts";

describe("parseAiStudioExport", () => {
  it("uses exact chunk counts and cumulative context without double-counting thoughts", () => {
    const records = parseAiStudioExport(
      {
        runSettings: { model: "models/gemini-2.5-pro" },
        systemInstruction: { text: "system" },
        chunkedPrompt: {
          chunks: [
            { role: "user", text: "first", tokenCount: 10 },
            { role: "model", text: "thinking", tokenCount: 3, isThought: true },
            { role: "model", text: "answer", tokenCount: 7 },
            { role: "user", text: "next", tokenCount: 5 },
            { role: "model", text: "second", tokenCount: 11 },
          ],
        },
      },
      { conversationId: "abc", importedAtMs: 1_000 },
    );

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: "aistudio",
      model: "gemini-2.5-pro",
      dedupeKey: "aistudio:abc:1",
      totals: { outputTokens: 10, reasoningTokens: 3 },
    });
    expect(records[1]?.totals.uncachedInputTokens).toBe(estimateChatTokens("system") + 10 + 10 + 5);
  });
});

describe("parseChatGptExport", () => {
  it("prices every generated branch once and reconstructs each branch context", () => {
    const records = parseChatGptExport(
      [
        {
          id: "conversation",
          create_time: 100,
          default_model_slug: "gpt-4o",
          mapping: {
            root: { id: "root", parent: null, message: null },
            user: {
              id: "user",
              parent: "root",
              message: { id: "u1", author: { role: "user" }, content: { parts: ["hello"] } },
            },
            answerA: {
              id: "answerA",
              parent: "user",
              message: {
                id: "a1",
                create_time: 101,
                author: { role: "assistant" },
                content: { parts: ["one"] },
                metadata: { model_slug: "gpt-4o" },
              },
            },
            answerB: {
              id: "answerB",
              parent: "user",
              message: {
                id: "a2",
                create_time: 102,
                author: { role: "assistant" },
                content: { parts: ["two"] },
                metadata: { model_slug: "gpt-4o" },
              },
            },
          },
        },
      ],
      { importedAtMs: 999_000 },
    );

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.dedupeKey)).toEqual([
      "chatgpt:conversation:a1",
      "chatgpt:conversation:a2",
    ]);
    expect(records[0]?.timestampMs).toBe(101_000);
    expect(records[0]?.totals.uncachedInputTokens).toBe(estimateChatTokens("hello"));
    expect(records[0]?.totals.outputTokens).toBe(estimateChatTokens("one"));
  });
});
