import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { idleEvidence } from "./t3-deploy-idle.mjs";
import { productionAdapter } from "./t3-deploy.mjs";
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

NodeTest.test(
  "nightly deployment distinguishes retained threads from active turns",
  async (test) => {
    const releaseRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-idle-"));
    test.after(() => NodeFS.rmSync(releaseRoot, { recursive: true }));
    NodeFS.writeFileSync(
      NodePath.join(releaseRoot, "state.json"),
      JSON.stringify({ current: "synthetic" }),
    );
    const threads = [{ id: "retained", status: "idle" }];
    const adapter = productionAdapter(
      { releaseRoot },
      {
        checkIdleOnce: true,
        recordIdle: false,
        cli: async () => ({
          ...base,
          threads,
          threadCount: threads.length,
          listPage: { nextOffset: null },
          voice: { coverage: "complete", count: 0, openCalls: [], activeSessions: [], runtime },
        }),
      },
    );
    NodeAssert.equal((await adapter.waitForIdle()).idle, true);
    threads[0].activeRunId = "turn-in-flight";
    await NodeAssert.rejects(adapter.waitForIdle(), /zero active turns/);
  },
);

NodeTest.test(
  "nightly health proves the serving process without dispatching a model turn",
  async () => {
    const requests = [];
    const adapter = productionAdapter(
      { healthUrls: ["synthetic:3774", "synthetic:6803", "synthetic:9445"] },
      {
        passiveHealth: true,
        owners: async () => [
          { mode: "server", pid: runtime.pid, release: "synthetic", paused: false },
          { mode: "web", pid: 2, release: "synthetic", paused: false },
        ],
        fetch: async () => ({ status: 200 }),
        cli: async (_release, request) => {
          requests.push(request);
          return { runtime };
        },
      },
    );
    const evidence = await adapter.health("synthetic");
    NodeAssert.equal(evidence.ok, true);
    NodeAssert.deepEqual(evidence.checks, [200, 200, 200]);
    NodeAssert.deepEqual(requests, [{ kind: "snapshot" }]);
  },
);
