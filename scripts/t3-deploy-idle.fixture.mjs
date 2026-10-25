import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { idleEvidence } from "./t3-deploy-idle.mjs";
const runtime = { pid: 1, startedAt: "2026-10-25T00:00:00Z" };
NodeTest.test("a background call turn still blocks after the call has hung up", () => {
  NodeAssert.equal(
    idleEvidence([
      {
        runtime,
        snapshotSequence: 1,
        threads: [],
        threadCount: 0,
        voice: {
          coverage: "complete",
          count: 0,
          openCalls: [],
          runtime,
          activeSessions: [{ threadId: "background", status: "running" }],
        },
      },
    ]).idle,
    false,
  );
});
const base = { runtime, snapshotSequence: 1, threads: [], threadCount: 0 };
const router = {
  speech: {
    voiceSessions: 0,
    tenants: ["whisper-large-v3-turbo", "breeze-tts-2"].map((id) => ({ id, running: false })),
  },
};
NodeTest.test("new servers never use legacy fallback", () => {
  NodeAssert.equal(
    idleEvidence([{ ...base, voice: { coverage: "unavailable" } }], router).idle,
    false,
  );
  NodeAssert.equal(
    idleEvidence([
      {
        ...base,
        voice: { coverage: "complete", count: 0, openCalls: [], activeSessions: [], runtime },
      },
    ]).idle,
    true,
  );
  NodeAssert.equal(
    idleEvidence([
      {
        ...base,
        voice: { coverage: "complete", count: 1, openCalls: [{ callId: "one" }], runtime },
      },
    ]).idle,
    false,
  );
});
NodeTest.test("old servers require router fallback and complete thread coverage", () => {
  NodeAssert.equal(idleEvidence([base], router).idle, true);
  NodeAssert.equal(idleEvidence([base]).idle, false);
  NodeAssert.equal(idleEvidence([{ ...base, threadCount: 1 }], router).idle, false);
  NodeAssert.equal(
    idleEvidence([{ ...base, threads: [{ id: "one", status: "running" }], threadCount: 1 }], router)
      .idle,
    false,
  );
});
