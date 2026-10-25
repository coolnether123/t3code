import { describe, expect, it } from "vite-plus/test";
import { voiceTurnInput } from "./turnInput.ts";

describe("ordinary voice turn input", () => {
  it("adds conversational guidance to a voice turn without altering its transcript", () => {
    const transcript = "Check the task.";
    expect(voiceTurnInput("voice:call:utterance", transcript)).toBe(
      `${transcript}\n\nThis turn came through a voice call. Reply conversationally. Lead with the answer in one or two short sentences, then offer details on request. Use natural language rather than tool JSON. Include further written detail if the request needs it.`,
    );
    expect(voiceTurnInput("typed-message", transcript)).toBe(transcript);
  });
});
