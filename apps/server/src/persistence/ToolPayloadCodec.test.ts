import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  retainEventPayload,
  retainToolPayload,
  restoreStoredPayload,
  restoreToolPayload,
} from "./ToolPayloadCodec.ts";
import { RetainedPayloadFromJsonString } from "./RetainedPayloadSchema.ts";
const decodeRetainedJson = Schema.decodeUnknownSync(RetainedPayloadFromJsonString);

describe("lossless tool payload retention", () => {
  const data = {
    item: {
      type: "mcpToolCall",
      result: { content: [{ type: "text", text: "synthetic long tool output\n".repeat(10000) }] },
    },
  };
  const payload = {
    requestId: "request-1",
    itemType: "mcpToolCall",
    detail: "synthetic",
    toolCallId: "call-1",
    data,
  };
  it("reduces storage without changing opaque data or SQL-visible metadata", () => {
    const retained = retainToolPayload(payload);
    expect(JSON.stringify(retained).length).toBeLessThan(JSON.stringify(payload).length / 10);
    expect(restoreToolPayload(retained)).toEqual(payload);
    expect(retained).toMatchObject({
      requestId: "request-1",
      detail: "synthetic",
      toolCallId: "call-1",
    });
    expect(payload.data).toBe(data);
  });
  it("hydrates event replay and JSON repository reads, preserving sequence-independent payloads", () => {
    const event = {
      threadId: "old-thread",
      activity: { id: "activity-1", kind: "tool.completed", turnId: "turn-1", payload },
    };
    const stored = retainEventPayload("thread.activity-appended", event);
    expect(restoreStoredPayload(stored)).toEqual(event);
    expect(decodeRetainedJson(JSON.stringify(stored))).toEqual(
      event,
    );
    expect(
      decodeRetainedJson(
        JSON.stringify(retainToolPayload(payload)),
      ),
    ).toEqual(payload);
  });
  it("leaves messages, plans, approvals, user inputs and unknown event types unchanged", () => {
    for (const kind of [
      "approval.requested",
      "user-input.requested",
      "task.progress",
      "provider.approval.respond.failed",
    ]) {
      const event = { activity: { kind, payload } };
      expect(retainEventPayload("thread.activity-appended", event)).toBe(event);
    }
    const message = { text: "synthetic original message".repeat(1000), role: "assistant", data };
    expect(retainEventPayload("thread.message-sent", message)).toBe(message);
  });
  it("escapes provider objects using the reserved marker without interpreting them", () => {
    const original = { data: { __t3CompressedToolDataV1: "provider-owned data" } };
    expect(restoreToolPayload(retainToolPayload(original))).toEqual(original);
  });
  it("fails closed on corrupted and unsupported encodings", () => {
    const stored = JSON.parse(JSON.stringify(retainToolPayload(payload)));
    stored.data.__t3CompressedToolDataV1.sha256 = "corrupted";
    expect(() => restoreToolPayload(stored)).toThrow("checksum");
    expect(() =>
      decodeRetainedJson(JSON.stringify(stored)),
    ).toThrow("Invalid retained");
    stored.data.__t3CompressedToolDataV1.codec = "future-codec";
    expect(() => restoreToolPayload(stored)).toThrow("Invalid retained");
  });
  it("keeps small and absent tool data unchanged", () => {
    for (const value of [null, {}, { data: null }, { data: "short" }])
      expect(retainToolPayload(value)).toBe(value);
  });
});
