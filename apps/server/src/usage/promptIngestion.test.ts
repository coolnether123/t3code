import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { parseAgentSessionTranscript } from "../project/AgentSessionScanner.ts";
import { promptWords } from "./promptWords.ts";

const at = "2026-10-09T12:00:00.000Z";
const parse = (records: unknown[]) =>
  parseAgentSessionTranscript({
    source: "codex",
    providerInstanceId: ProviderInstanceId.make("codex-fixture"),
    fallbackSessionId: "fixture",
    lastActiveAtMs: Date.parse(at),
    contents: records.map((record) => JSON.stringify(record)).join("\n"),
  });
const identity = { type: "session_meta", payload: { id: "fixture-session" } };
const event = {
  type: "event_msg",
  timestamp: at,
  payload: { type: "user_message", message: "Repeated voice prompt" },
};
const response = {
  type: "response_item",
  timestamp: at,
  payload: {
    type: "message",
    role: "user",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-one" },
    content: [{ type: "input_text", text: "Repeated voice prompt" }],
  },
};
const assistant = {
  type: "response_item",
  timestamp: at,
  payload: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Excluded reply" }],
  },
};

describe("prompt ingestion provenance", () => {
  it("collapses response/event voice mirrors while retaining a later identical submission", () => {
    const thread = parse([
      identity,
      response,
      event,
      assistant,
      event,
      {
        ...response,
        payload: {
          ...response.payload,
          internal_chat_message_metadata_passthrough: { turn_id: "turn-two" },
        },
      },
    ]);
    const users = thread?.messages.filter((message) => message.role === "user") ?? [];
    expect(users).toHaveLength(2);
    expect(users.reduce((total, message) => total + promptWords(message.text).length, 0)).toBe(6);
  });
  it("exposes why persisted imports cannot prove complete personal history", () => {
    const thread = parse([identity, event, ...Array.from({ length: 210 }, () => assistant)]);
    expect(thread?.messages).toHaveLength(200);
    expect(thread?.messages[0]?.text).toBe("Repeated voice prompt");
    // The stored import drops earlier messages and has no completeness marker.
    expect(thread).not.toHaveProperty("complete");
  });
});
