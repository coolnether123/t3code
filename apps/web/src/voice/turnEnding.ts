export interface SpeechTimeline {
  speechMs: number;
  lastBurstMs: number;
  silenceMs: number;
  transcript?: string;
  finishAtPause?: boolean;
}

/** Short starts and trailing fragments need more room than a sustained utterance. */
export function shouldEndTurn(timeline: SpeechTimeline) {
  if (!timeline.speechMs) return !!timeline.finishAtPause && timeline.silenceMs >= 1_050;
  const text = timeline.transcript?.trim();
  const trailing = text && /\b(?:um|uh|well|so|and|like)[,.!?\s]*$/i.test(text);
  const finished = text && !trailing && /[.!?]$/.test(text);
  const unfinished =
    trailing || (!finished && (timeline.speechMs < 1_000 || timeline.lastBurstMs < 350));
  return timeline.silenceMs >= (unfinished ? 1_850 : 1_050);
}
