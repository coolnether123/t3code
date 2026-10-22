import { floorCue } from "@t3tools/client-runtime/voice-call/floor";

export interface SpeechTimeline {
  speechMs: number;
  lastBurstMs: number;
  silenceMs: number;
  transcript?: string;
  finishAtPause?: boolean;
}

/** Acoustic quiet cannot establish that a thought is complete. */
export function shouldEndTurn(timeline: SpeechTimeline) {
  if (!timeline.speechMs) return !!timeline.finishAtPause && timeline.silenceMs >= 1_050;
  const cue = floorCue(timeline.transcript ?? "");
  return cue !== "hold" && timeline.silenceMs >= (cue === "yield" ? 200 : 700);
}
