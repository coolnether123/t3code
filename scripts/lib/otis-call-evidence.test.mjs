import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  validatePcmWav,
  watchCallReceipts,
  completedOtisTool,
  callTimings,
  verifyCallRaw,
  sentenceSpeechId,
  sentenceTimings,
} from "./otis-call-evidence.mjs";
import * as NodeCrypto from "node:crypto";

NodeTest.test(
  "measures each sentence without treating missing or cancelled audio as zero latency",
  () => {
    NodeAssert.deepEqual(
      sentenceTimings({
        queuedAt: 1000,
        requestedAt: 1200,
        firstScheduledAudioAt: 1400,
        synthesisCompletedAt: 4000,
      }),
      {
        ttsMs: 2800,
        requestToFirstAudioMs: 200,
        queuedToFirstAudioMs: 400,
        streamedBeforeSynthesisCompleted: true,
      },
    );
    NodeAssert.equal(sentenceTimings({ requestedAt: 1200 }).ttsMs, null);
    NodeAssert.equal(
      callTimings({ firstSentence: 1000, firstScheduledAudio: 1400 }).firstSentenceToFirstAudio,
      400,
    );
    NodeAssert.equal(
      sentenceSpeechId({ messageId: "message", start: 0, end: 12 }),
      "s-15b4f38ed1ffbd5fc94b80c410faaefc1b6c41cc62d6c3fab915b6f04e3efd40",
    );
  },
);

NodeTest.test(
  "matches successful canonical Claude Otis MCP receipts by exact server and tool",
  () => {
    const event = {
      type: "item.completed",
      payload: {
        itemType: "mcp_tool_call",
        status: "completed",
        title: "MCP tool call",
        data: { toolName: "mcp__otis__get_task" },
      },
    };
    NodeAssert.equal(completedOtisTool(event, "get_task"), true);
    NodeAssert.equal(completedOtisTool(event, "mcp__otis__get_task"), true);
    for (const payload of [
      { ...event.payload, status: "failed" },
      { ...event.payload, data: { toolName: "mcp__otis__list_tasks" } },
      { ...event.payload, data: { toolName: "mcp__other__get_task" } },
      { ...event.payload, itemType: "command_execution" },
      { ...event.payload, data: {} },
    ])
      NodeAssert.equal(completedOtisTool({ ...event, payload }, "get_task"), false);
  },
);
NodeTest.test(
  "computes elapsed and consecutive stage timings even when audio acceptance failed",
  () => {
    const stages = {
      speechEnded: 1000,
      uploadAcknowledgment: 1100,
      transcript: 9600,
      delivery: 9750,
      firstRenderedText: 11000,
    };
    NodeAssert.deepEqual(callTimings(stages), {
      uploadAcknowledgment: 100,
      transcript: 8600,
      delivery: 8750,
      firstRenderedText: 10000,
      firstScheduledAudio: null,
      speechEndToTranscript: 8600,
      transcriptToDelivery: 150,
      deliveryToFirstText: 1250,
      firstTextToFirstAudio: null,
      firstSentenceToFirstAudio: null,
    });
    NodeAssert.equal(
      callTimings({ ...stages, firstScheduledAudio: 12000 }).firstTextToFirstAudio,
      1000,
    );
    NodeAssert.equal(callTimings({ transcript: 100 }).speechEndToTranscript, null);
  },
);
NodeTest.test(
  "verifies acknowledged raw audio in the server archive before transcript or speech exists",
  async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-raw-proof-"));
    const directory = NodePath.join(home, "userdata/voice/calls/call");
    const pcm = Buffer.from([1, 0, 2, 0]);
    const sha256 = NodeCrypto.createHash("sha256").update(pcm).digest("hex");
    try {
      await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(directory, "utterance.pcm"), pcm);
      await NodeFSP.writeFile(
        NodePath.join(directory, "utterance.raw.json"),
        JSON.stringify({ bytes: pcm.length, sha256 }),
      );
      const uploaded = { callId: "call", utteranceId: "utterance", audio: pcm.toString("base64") };
      NodeAssert.deepEqual(await verifyCallRaw(home, uploaded), {
        rawVerified: true,
        rawSha256: sha256,
        rawBytes: 4,
      });
      await NodeFSP.writeFile(NodePath.join(directory, "utterance.pcm"), Buffer.from([0, 0]));
      await NodeAssert.rejects(verifyCallRaw(home, uploaded));
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  },
);

function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF");
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  return bytes;
}
NodeTest.test("validates mono integer PCM before launching a browser", () => {
  NodeAssert.deepEqual(validatePcmWav(wav()), { sampleRate: 16000, audioBytes: 4 });
});
NodeTest.test("rejects compressed audio, mismatched lengths and truncated chunks", () => {
  const compressed = wav();
  compressed.writeUInt16LE(3, 20);
  NodeAssert.throws(() => validatePcmWav(compressed));
  NodeAssert.throws(() => validatePcmWav(wav().subarray(0, 46)));
  const truncated = wav();
  truncated.writeUInt32LE(100, 40);
  NodeAssert.throws(() => validatePcmWav(truncated));
});
NodeTest.test(
  "waits for newly appended canonical completion receipts and excludes prior and other-thread records",
  async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-voice-receipts-"));
    const path = NodePath.join(directory, "synthetic.log");
    const line = (event) => `[2026-10-18T00:00:00Z] CANON: ${JSON.stringify(event)}\n`;
    await NodeFSP.writeFile(
      path,
      line({ type: "turn.completed", threadId: "target", eventId: "old" }),
    );
    const events = [];
    const receipts = await watchCallReceipts(path, "target", (event) => events.push(event.eventId));
    try {
      await NodeFSP.appendFile(
        path,
        line({ type: "turn.completed", threadId: "other", eventId: "unrelated" }) +
          line({ type: "turn.completed", threadId: "target", eventId: "new" }),
      );
      const result = await receipts.completion;
      NodeAssert.equal(result.eventId, "new");
      NodeAssert.deepEqual(events, ["new"]);
    } finally {
      receipts.close();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
