import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ChatHistoryReadInput, ChatHistorySearchInput } from "./chatSearch.ts";
const search = Schema.decodeUnknownSync(ChatHistorySearchInput);
const read = Schema.decodeUnknownSync(ChatHistoryReadInput);

it("bounds text, dates, identifiers and read pages", () => {
  expect(search({ query: "", from: "2026-10-06T00:00:00.000Z" }).query).toBe("");
  expect(() => search({ query: "x".repeat(201) })).toThrow();
  expect(() => search({ query: "needle", from: "yesterday" })).toThrow();
  expect(() => search({ query: "needle", from: "2026-02-30T00:00:00.000Z" })).toThrow();
  expect(() =>
    search({
      query: "needle",
      from: "2026-10-07T00:00:00.000Z",
      before: "2026-10-06T00:00:00.000Z",
    }),
  ).toThrow();
  expect(() =>
    read({
      source: "t3",
      threadId: "synthetic",
      offset: -1,
    }),
  ).toThrow();
  expect(() => read({ source: "codex-app", threadId: "" })).toThrow();
});
