import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeMethods } from "@effect/vitest";
import { expect, it } from "vite-plus/test";

import { openCodexThread } from "./CodexSessionRuntime.ts";

const effectIt = makeMethods(it);

effectIt.effect("opens bounded history through raw thread/resume in message order", () =>
  Effect.gen(function* () {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const client = {
      request: () => Effect.die(new Error("Typed request would discard history")),
      raw: {
        request: (method: string, payload: unknown) => {
          calls.push({ method, payload });
          return Effect.succeed({ thread: { id: "new-thread" } });
        },
      },
    };
    yield* openCodexThread({
      client,
      threadId: ThreadId.make("old-thread"),
      runtimeMode: "full-access",
      cwd: "/tmp/project",
      requestedModel: "gpt-5.3-codex",
      serviceTier: undefined,
      resumeThreadId: undefined,
      seedHistory: [
        { role: "user", text: "old".repeat(60_000) },
        { role: "assistant", text: "answer" },
        { role: "user", text: "latest" },
      ],
    });
    expect(calls[0]?.method).toBe("thread/resume");
    const payload = calls[0]?.payload as {
      threadId: string;
      history: Array<{
        role: string;
        content: Array<{ type: string; text: string }>;
      }>;
    };
    expect(payload.threadId).toBe("");
    expect(payload.history.map((item) => item.role)).toEqual(["user", "assistant", "user"]);
    expect(payload.history.map((item) => item.content[0]?.type)).toEqual([
      "input_text",
      "output_text",
      "input_text",
    ]);
    expect(payload.history.reduce((sum, item) => sum + item.content[0]!.text.length, 0)).toBe(
      150_000,
    );
    expect(payload.history[0]?.content[0]?.text).toMatch(/^\[Earlier messages were trimmed/);
    expect(payload.history[2]?.content[0]?.text).toBe("latest");
  }),
);
