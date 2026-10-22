export type FloorState = "listening" | "provisional-end" | "committed" | "speaking" | "interrupted";
export interface TranscriptRevision {
  text: string;
  revision: number;
  final: boolean;
}

const yieldPattern =
  /\b(?:you can speak|you have the floor|go ahead|over to you|what do you think)[.!?,\s]*$/i;
const trailingFragment =
  /\b(?:um|uh|erm|hmm|well|and|so|but|like|because|if|when|or|then|to|with|for|of|the|a|an|my|your|i|i mean|actually|let me|i want|i need|going to|can you|could you|would you|will you)[,.!?\s]*$/i;

export function floorCue(text: string): "yield" | "finished" | "hold" {
  const trimmed = text.trim();
  if (!trimmed || trailingFragment.test(trimmed)) return "hold";
  if (/\b(?:don't|do not)\s+(?:answer|speak|respond)(?:\s+yet)?[.!?,\s]*$/i.test(trimmed))
    return "hold";
  if (yieldPattern.test(trimmed) || /(?:^|[.!?;]\s*)(?:please\s+)?answer[.!?,\s]*$/i.test(trimmed))
    return "yield";
  if (/\b(?:hang on|give me a moment|wait a second|let me think)[.!?,\s]*$/i.test(trimmed))
    return "hold";
  return /[.!?]["')\]]*$/.test(trimmed) && /\p{L}/u.test(trimmed) ? "finished" : "hold";
}

export function floorCommitDelay(text: string) {
  const cue = floorCue(text);
  if (cue === "hold") return undefined;
  if (cue === "yield") return 200;
  // A short context-dependent question often precedes a second question after a thinking pause.
  if (/\?["')\]]*\s*$/.test(text) && (text.match(/\p{L}+/gu)?.length ?? 0) <= 3) return 3000;
  return 700;
}

/** Recognition segments are revisable evidence. Only a completion cue or a tap yields the floor. */
export class FloorController {
  state: FloorState = "listening";
  transcript: TranscriptRevision = { text: "", revision: 0, final: false };
  private deadline: number | undefined;
  private lastSpeech = 0;

  update(value: TranscriptRevision, at: number) {
    if (value.revision <= this.transcript.revision || this.state === "committed") return false;
    this.transcript = value;
    this.lastSpeech = at;
    const delay = floorCommitDelay(value.text);
    this.deadline = delay === undefined ? undefined : at + delay;
    this.state = this.deadline === undefined ? "listening" : "provisional-end";
    return true;
  }

  activity(at: number) {
    this.lastSpeech = at;
    this.deadline = undefined;
    if (this.state !== "speaking" && this.state !== "committed") this.state = "listening";
  }

  tick(at: number) {
    if (this.deadline === undefined || at < this.deadline || this.state !== "provisional-end")
      return false;
    this.state = "committed";
    this.deadline = undefined;
    return true;
  }

  manual() {
    this.state = "committed";
    this.deadline = undefined;
  }

  speaking() {
    this.state = "speaking";
  }
  interrupt() {
    this.state = "interrupted";
    this.deadline = undefined;
  }
  get quietSince() {
    return this.lastSpeech;
  }
  get commitAt() {
    return this.deadline;
  }
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

export function isAcknowledgment(text: string) {
  return /^(?:mm[ -]?hmm|mhm|mm|yeah|yes|right|ok|okay|uh[ -]?huh)[.!?,\s]*$/i.test(text.trim());
}

/** Conservative text gate supplements browser AEC; it does not prove acoustic echo rejection. */
export function isPlaybackEcho(text: string, emitting: string) {
  const input = words(text);
  const output = words(emitting);
  if (!input.length || !output.length) return false;
  return (
    output.join(" ").includes(input.join(" ")) ||
    (input.length >= 3 &&
      input.filter((word) => output.includes(word)).length / input.length >= 0.8)
  );
}

export function acceptsBargeIn(text: string, emitting: string, voicedMs: number) {
  return (
    voicedMs >= 180 &&
    words(text).length > 0 &&
    !isAcknowledgment(text) &&
    !isPlaybackEcho(text, emitting)
  );
}
