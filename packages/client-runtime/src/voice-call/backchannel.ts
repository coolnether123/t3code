import { floorCue, type TranscriptRevision } from "./floor.ts";

export type BackchannelCue = {
  revision: number;
  token: "mm-hmm" | "mm";
  reason: "completed-clause-pause";
};

/** Acknowledgments never change floor ownership or dispatch a conversation turn. */
export class BackchannelPolicy {
  private startedAt = 0;
  private lastAt = -Infinity;
  private lastToken: BackchannelCue["token"] = "mm";
  private current: TranscriptRevision = { text: "", revision: 0, final: false };
  private updatedAt = 0;

  reset(at: number) {
    this.startedAt = at;
    this.current = { text: "", revision: 0, final: false };
  }
  update(value: TranscriptRevision, at: number) {
    this.current = value;
    this.updatedAt = at;
  }
  activity(at: number) {
    this.updatedAt = at;
  }

  cue(at: number): BackchannelCue | undefined {
    const { text, revision } = this.current;
    if (
      at - this.startedAt < 8000 ||
      at - this.lastAt < 9000 ||
      at - this.updatedAt < 350 ||
      at - this.updatedAt > 650
    )
      return;
    if (
      text.split(/\s+/).length < 12 ||
      /\?/.test(text) ||
      floorCue(text) !== "hold" ||
      !/[,;]["')\]]*\s*$/.test(text)
    )
      return;
    return {
      revision,
      token: this.lastToken === "mm" ? "mm-hmm" : "mm",
      reason: "completed-clause-pause",
    };
  }

  valid(cue: BackchannelCue, at: number) {
    return this.cue(at)?.revision === cue.revision;
  }
  played(cue: BackchannelCue, at: number) {
    this.lastAt = at;
    this.lastToken = cue.token;
  }
}
