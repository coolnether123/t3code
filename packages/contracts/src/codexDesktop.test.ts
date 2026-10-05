import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  CodexDesktopSendMessageResponse,
  CodexDesktopThreadHistoryResponse,
  CodexScheduledRoutineListResponse,
  CodexScheduledRunListResponse,
} from "./codexDesktop.ts";

describe("Codex desktop contracts", () => {
  it("accepts native history with untimestamped items and tool activity", () => {
    const history = Schema.decodeUnknownSync(CodexDesktopThreadHistoryResponse)({
      thread: {
        id: "thread-1",
        title: "Release review",
        updatedAt: "2026-09-07T12:00:00.000Z",
        preview: "Inspect the release notes",
        cwd: "A:/Dev",
        status: "active",
      },
      messages: [
        {
          id: "item-1",
          role: "tool",
          text: "Reading files",
          createdAt: null,
          tool: { name: "shell", status: "completed", detail: "3 files" },
        },
      ],
      nextCursor: null,
    });

    expect(history.messages[0]?.createdAt).toBeNull();
    expect(history.messages[0]?.tool?.name).toBe("shell");
  });

  it("keeps delivery state distinct from native agent state", () => {
    const delivery = Schema.decodeUnknownSync(CodexDesktopSendMessageResponse)({
      requestId: "request-1",
      status: "queued",
      message: null,
      error: null,
    });

    expect(delivery.status).toBe("queued");
  });

  it("decodes a compact scheduled routine and archived run page", () => {
    const run = {
      id: "run-1",
      createdAt: "2026-09-28T12:00:00.000Z",
      preview: "Done",
      archived: true,
    };
    const routines = Schema.decodeUnknownSync(CodexScheduledRoutineListResponse)({
      routines: [{ name: "Inbox", latestRun: run, runCount: 344 }],
      nextCursor: null,
    });
    const history = Schema.decodeUnknownSync(CodexScheduledRunListResponse)({
      runs: [run],
      nextCursor: "25",
    });
    expect(routines.routines[0]?.latestRun.archived).toBe(true);
    expect(history.nextCursor).toBe("25");
    expect(() =>
      Schema.decodeUnknownSync(CodexScheduledRunListResponse)({
        runs: [{ ...run, archived: 1 }],
        nextCursor: null,
      }),
    ).toThrow();
  });
});
