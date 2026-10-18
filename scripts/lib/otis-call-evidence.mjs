import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export function validatePcmWav(bytes) {
  NodeAssert.ok(
    bytes.length >= 44 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WAVE",
    "Use a PCM WAV recording.",
  );
  NodeAssert.equal(
    bytes.readUInt32LE(4) + 8,
    bytes.length,
    "WAV container length does not match its bytes.",
  );
  let format;
  let audioBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    NodeAssert.ok(end <= bytes.length, "Truncated WAV chunk.");
    const name = bytes.toString("ascii", offset, offset + 4);
    if (name === "fmt ") {
      NodeAssert.ok(length >= 16, "Truncated WAV format.");
      format = {
        encoding: bytes.readUInt16LE(offset + 8),
        channels: bytes.readUInt16LE(offset + 10),
        rate: bytes.readUInt32LE(offset + 12),
        byteRate: bytes.readUInt32LE(offset + 16),
        align: bytes.readUInt16LE(offset + 20),
        bits: bytes.readUInt16LE(offset + 22),
      };
    }
    if (name === "data") audioBytes += length;
    offset = end + (length % 2);
  }
  NodeAssert.ok(
    format &&
      format.encoding === 1 &&
      format.channels === 1 &&
      format.bits === 16 &&
      format.align === 2 &&
      format.byteRate === format.rate * 2 &&
      format.rate >= 8000 &&
      format.rate <= 96000,
    "Use mono 16-bit integer PCM at 8–96 kHz.",
  );
  NodeAssert.ok(
    audioBytes > 0 && audioBytes % 2 === 0 && audioBytes <= format.rate * 2 * 55,
    "Use a nonempty WAV shorter than 55 seconds, with a spoken request and trailing silence.",
  );
  return { sampleRate: format.rate, audioBytes };
}

/** Consume appended provider receipts only. Private payloads remain in the owner's log. */
export async function watchCallReceipts(path, threadId, onEvent) {
  let offset = await NodeFSP.stat(path).then(
    (stat) => stat.size,
    (error) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    },
  );
  let partial = "";
  let tail = Promise.resolve();
  let closed = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Rejections are still propagated to the caller; early browser setup cannot leak one.
  void completion.catch(() => {});
  const read = async () => {
    if (closed) return;
    const file = await NodeFSP.open(path, "r").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!file) return;
    try {
      const stat = await file.stat();
      NodeAssert.ok(
        stat.size >= offset,
        "Provider log rotated during acceptance. Retain the logs and repeat in a fresh chat.",
      );
      const size = stat.size - offset;
      NodeAssert.ok(
        size <= 16 * 1024 * 1024,
        "Provider receipt batch is too large to inspect safely.",
      );
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await file.read(bytes, 0, size, offset);
      offset += bytesRead;
      const lines = (partial + bytes.subarray(0, bytesRead).toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/^\[[^\]]+\] CANON: (.+)$/);
        if (!match) continue;
        const event = JSON.parse(match[1]);
        if (event.threadId !== threadId) continue;
        onEvent(event);
        if (event.type === "turn.completed") resolveCompletion(event);
      }
    } finally {
      await file.close();
    }
  };
  const watcher = NodeFS.watch(NodePath.dirname(path), (_event, name) => {
    if (String(name) !== NodePath.basename(path)) return;
    tail = tail.then(read).catch(rejectCompletion);
  });
  watcher.on("error", rejectCompletion);
  return {
    completion,
    drain: () => tail,
    close: () => {
      closed = true;
      watcher.close();
    },
  };
}
