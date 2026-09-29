import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  prepareDesktopDraftPrompt,
  serializeTaskTranscript,
  serializeTaskTranscripts,
} from "./chatTranscript";

describe("prepareDesktopDraftPrompt", () => {
  it("labels copied context honestly without changing the original transcript", () => {
    const transcript = "Earlier user and assistant messages";
    const prompt = prepareDesktopDraftPrompt("Old chat", transcript);
    expect(prompt).toContain("not a native provider continuation");
    expect(prompt).toContain("Earlier turns may be omitted");
    expect(prompt?.endsWith(transcript)).toBe(true);
    expect(transcript).toBe("Earlier user and assistant messages");
  });

  it("refuses a transcript that cannot fit in one provider message", () => {
    const emptyPrompt = prepareDesktopDraftPrompt("Old chat", "")!;
    expect(
      prepareDesktopDraftPrompt(
        "Old chat",
        "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - emptyPrompt.length),
      ),
    ).toHaveLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(
      prepareDesktopDraftPrompt(
        "Old chat",
        "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - emptyPrompt.length + 1),
      ),
    ).toBeNull();
  });
});

describe("serializeTaskTranscript", () => {
  it("exports messages, tool invocations, complete command results, and errors chronologically", () => {
    const messages: OrchestrationMessage[] = [
      {
        id: MessageId.make("assistant-1"),
        role: "assistant",
        text: "Finished checking.",
        turnId: TurnId.make("turn-1"),
        streaming: false,
        createdAt: "2026-08-22T12:00:04.000Z",
        updatedAt: "2026-08-22T12:00:04.000Z",
      },
      {
        id: MessageId.make("user-1"),
        role: "user",
        text: "Inspect the build",
        turnId: null,
        streaming: false,
        createdAt: "2026-08-22T12:00:01.000Z",
        updatedAt: "2026-08-22T12:00:01.000Z",
      },
    ];
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.make("event-result"),
        kind: "tool.call.completed",
        tone: "tool",
        summary: "Command completed",
        payload: { exitCode: 1, stderr: "full failure output", stdout: "all output lines" },
        turnId: TurnId.make("turn-1"),
        sequence: 3,
        createdAt: "2026-08-22T12:00:03.000Z",
      },
      {
        id: EventId.make("event-call"),
        kind: "tool.call.started",
        tone: "tool",
        summary: "Run command",
        payload: { command: "vp check" },
        turnId: TurnId.make("turn-1"),
        sequence: 2,
        createdAt: "2026-08-22T12:00:02.000Z",
      },
    ];

    const transcript = serializeTaskTranscript({
      title: "Build inspection",
      threadId: ThreadId.make("thread-1"),
      messages,
      activities,
    });

    expect(transcript.indexOf("USER MESSAGE")).toBeLessThan(
      transcript.indexOf("tool.call.started"),
    );
    expect(transcript.indexOf("tool.call.started")).toBeLessThan(
      transcript.indexOf("tool.call.completed"),
    );
    expect(transcript.indexOf("tool.call.completed")).toBeLessThan(
      transcript.indexOf("ASSISTANT MESSAGE"),
    );
    expect(transcript).toContain('"stdout": "all output lines"');
    expect(transcript).toContain('"stderr": "full failure output"');
    expect(transcript).toContain('"exitCode": 1');
  });

  it("does not export hidden system messages", () => {
    const transcript = serializeTaskTranscript({
      title: "Safe export",
      threadId: "thread-safe",
      messages: [
        {
          id: MessageId.make("system-1"),
          role: "system",
          text: "hidden runtime instructions",
          turnId: null,
          streaming: false,
          createdAt: "2026-08-22T12:00:00.000Z",
          updatedAt: "2026-08-22T12:00:00.000Z",
        },
      ],
      activities: [],
    });

    expect(transcript).not.toContain("hidden runtime instructions");
  });
});

describe("serializeTaskTranscripts", () => {
  it("keeps the supplied chat order and separates complete transcripts", () => {
    const transcripts = serializeTaskTranscripts([
      { title: "First chat", threadId: "thread-1", messages: [], activities: [] },
      { title: "Second chat", threadId: "thread-2", messages: [], activities: [] },
    ]);

    expect(transcripts.indexOf("CHAT 1 OF 2")).toBeLessThan(transcripts.indexOf("CHAT 2 OF 2"));
    expect(transcripts.indexOf("Title: First chat")).toBeLessThan(
      transcripts.indexOf("Title: Second chat"),
    );
    expect(transcripts).toContain("Task: thread-1");
    expect(transcripts).toContain("Task: thread-2");
  });

  it("returns empty text for an empty selection", () => {
    expect(serializeTaskTranscripts([])).toBe("");
  });
});
