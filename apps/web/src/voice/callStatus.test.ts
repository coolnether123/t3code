import { describe, expect, it } from "vite-plus/test";
import type { CallStatus } from "@t3tools/contracts";
import { callStatusLabel, callElapsedLabel } from "./callStatus";

describe("compact call status", () => {
  it.each([
    ["listening", "Listening"],
    ["transcribing", "Got it, writing that down"],
    ["waiting", "Otis is thinking"],
    ["speaking", "Otis is talking"],
    ["reconnecting", "Reconnecting"],
    ["preparing", "Getting ready. You can type to Otis meanwhile."],
  ] as const)("labels %s", (state, label) => expect(callStatusLabel(state)).toBe(label));
  it("shows the latest background progress or actionable question", () => {
    const call: Pick<CallStatus, "operatorWorking" | "operatorUpdates"> = {
      operatorWorking: true,
      operatorUpdates: [
        { id: "u", jobId: "j", status: "progress", text: "Checking\nthe build", createdAt: "now" },
      ],
    };
    expect(callStatusLabel("listening", call)).toBe("Background agent working: Checking the build");
    expect(
      callStatusLabel("listening", {
        ...call,
        operatorUpdates: [
          {
            ...call.operatorUpdates![0]!,
            status: "needs-Jared",
            text: "Run tests. Approve in the chat.",
          },
        ],
      }),
    ).toBe("Needs you: Run tests. Approve in the chat.");
    expect(callElapsedLabel(4)).toBe("");
    expect(callElapsedLabel(5)).toBe("5s");
  });
});
