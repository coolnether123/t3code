import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { validatePcmWav, watchCallReceipts } from "./otis-call-evidence.mjs";

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
