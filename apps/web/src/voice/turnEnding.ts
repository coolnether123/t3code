import { floorCommitDelay } from "@t3tools/client-runtime/voice-call/floor";

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
  const delay = floorCommitDelay(timeline.transcript ?? "");
  return delay !== undefined && timeline.silenceMs >= delay;
}
