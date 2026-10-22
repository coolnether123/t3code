// @effect-diagnostics nodeBuiltinImport:off -- Private generated PCM cache belongs to the call service storage boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { SpeechResponse } from "@t3tools/contracts";
import { sha256 } from "./callStore.ts";

/** Generate neutral clips once per voice/model and retain them outside Git. */
export class BackchannelClips {
  private pending = new Map<string, Promise<SpeechResponse>>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  async record(callId: string, token: string, revision: number, at: string) {
    const path = NodePath.join(this.root, callId, "backchannels.jsonl");
    await NodeFSP.appendFile(
      path,
      `${JSON.stringify({ token, revision, at, cue: "completed-clause-pause", status: "scheduled" })}\n`,
    );
  }

  get(token: string, model: string, synthesize: () => Promise<SpeechResponse>) {
    if (token !== "mm-hmm" && token !== "mm") throw new Error("Unknown listening acknowledgment.");
    const key = sha256(`otis:${model}:${token}`);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.load(key, synthesize).catch((error) => {
        this.pending.delete(key);
        throw error;
      });
      this.pending.set(key, pending);
    }
    return pending;
  }
  private async load(
    key: string,
    synthesize: () => Promise<SpeechResponse>,
  ): Promise<SpeechResponse> {
    const path = NodePath.join(this.root, "_backchannels", `${key}.json`);
    try {
      const cached: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
      if (
        cached &&
        typeof cached === "object" &&
        "audio" in cached &&
        "sampleRate" in cached &&
        typeof cached.audio === "string" &&
        typeof cached.sampleRate === "number" &&
        Number.isInteger(cached.sampleRate) &&
        cached.sampleRate >= 8000 &&
        cached.sampleRate <= 96000
      ) {
        const length = Buffer.from(cached.audio, "base64").length;
        if (length > 0 && length % 2 === 0 && length <= cached.sampleRate * 2)
          return { audio: cached.audio, sampleRate: cached.sampleRate };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const clip = await synthesize();
    if (
      !clip.audio ||
      !clip.sampleRate ||
      Buffer.from(clip.audio, "base64").length > clip.sampleRate * 2
    )
      throw new Error("Listening acknowledgment is missing or too long.");
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(
      path,
      JSON.stringify({ audio: clip.audio, sampleRate: clip.sampleRate }),
    );
    return clip;
  }
}
