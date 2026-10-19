import { describe, expect, it } from "@effect/vitest";

import { parseClaudeLine } from "./usageTranscripts.ts";

function claudeLine(model: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-19T18:00:00.000Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    message: {
      id: "msg_1",
      model,
      usage: { input_tokens: 2, output_tokens: 3 },
    },
  });
}

describe("parseClaudeLine", () => {
  it("skips Claude Code's local placeholder model", () => {
    expect(parseClaudeLine(claudeLine("<synthetic>"))).toBeNull();
    expect(parseClaudeLine(claudeLine("claude-fable-5"))?.model).toBe("claude-fable-5");
  });
});
