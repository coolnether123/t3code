import { describe, expect, it } from "@effect/vitest";
import type { OtisNode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  applyFleetEvent,
  applyTreeBatch,
  canRetryFleetRun,
  flattenFleet,
  fleetNeedsYou,
  fleetRowLabels,
  offlineFleet,
} from "./tree.ts";

const lane: OtisNode = {
  id: "parent",
  parent: null,
  lane: "work",
  kind: "lane",
  mode: null,
  origin: "host",
  order: 1,
  title: "Work",
  provider: "fixture",
  model: "Test model",
  modelEvidence: "requested",
  effort: null,
  state: "idle",
  stateReason: null,
  stateBy: null,
  observedAt: "2026-11-23T03:14:00Z",
  lastKnown: false,
  waiting: 0,
  tokens: { in: 2, out: 2, cached: 0, total: 4 },
  tokensReason: null,
  costUsd: null,
  costSource: "unpriced",
  sub: { nodes: 0, running: 0, waiting: 0, failedUnseen: 0, tokens: 0 },
  budget: null,
  chat: { host: "t3", environmentId: "home", threadId: "thread" },
  can: ["message"],
  startedAt: "2026-11-23T03:14:00Z",
  endedAt: null,
  seenAt: null,
  settled: false,
  rev: 1,
  tailSeq: 0,
};
describe("fleet rows", () => {
  it("counts only outstanding requests on active native threads", () => {
    const nodes = new Map([[lane.id, lane]]);
    const request = {
      environmentId: "home",
      threadId: "thread",
      pendingRuntimeRequest: { id: "q", createdAt: DateTime.makeUnsafe("2026-11-23T03:13:00Z") },
    };
    expect(fleetNeedsYou(nodes, [request])).toEqual(new Set([lane.id]));
    expect(fleetNeedsYou(nodes, [{ ...request, settledOverride: "settled" }])).toEqual(new Set());
    expect(
      fleetNeedsYou(nodes, [
        { ...request, latestRunCompletedAt: DateTime.makeUnsafe(lane.startedAt) },
      ]),
    ).toEqual(new Set());
  });
  it("offers Retry only for the latest unseen failure while its lane is still idle", () => {
    const endedAt = "2026-11-23T04:00:00Z";
    const failed: OtisNode = {
      ...lane,
      id: "failed",
      parent: lane.id,
      lane: lane.id,
      kind: "run",
      state: "failed",
      endedAt,
      model: "GPT-6.2 Sol",
      taskId: "task",
    };
    const parent = { ...lane, lastActivityAt: endedAt };
    expect(canRetryFleetRun(failed, new Map([[lane.id, parent]]))).toBe(true);
    expect(canRetryFleetRun({ ...failed, seenAt: endedAt }, new Map([[lane.id, parent]]))).toBe(
      false,
    );
    expect(canRetryFleetRun({ ...failed, model: "GPT-5 Neon" }, new Map([[lane.id, parent]]))).toBe(
      false,
    );
    expect(
      canRetryFleetRun(
        failed,
        new Map([[lane.id, { ...parent, lastActivityAt: "2026-11-23T04:01:00Z" }]]),
      ),
    ).toBe(false);
    expect(
      canRetryFleetRun(
        failed,
        new Map([
          [lane.id, parent],
          ["newer", { ...failed, id: "newer", startedAt: "2026-11-23T03:59:00Z" }],
        ]),
      ),
    ).toBe(false);
    const running = { ...failed, state: "running", endedAt: null, rev: 1 } as const;
    const old = new Map([
      [lane.id, lane],
      [running.id, running],
    ]);
    const observed = { ...failed, rev: 2 };
    const observedFailure = applyTreeBatch(old, { seq: 2, nodes: [{ ...lane, rev: 2 }, observed] });
    expect(canRetryFleetRun(observed, observedFailure)).toBe(true);
    expect(
      canRetryFleetRun(
        observed,
        applyTreeBatch(observedFailure, { seq: 3, nodes: [{ ...lane, rev: 3 }] }),
      ),
    ).toBe(false);
  });
  it("keeps all 499 children behind their fold, then promotes the child needing attention without scrambling its peers", () => {
    const children = Array.from({ length: 499 }, (_, index): OtisNode => ({
      ...lane,
      id: `run-${index}`,
      kind: "run",
      parent: lane.id,
      order: null,
      mode: "task",
      chat: { host: "otis" },
    }));
    const nodes = applyTreeBatch(new Map(), { seq: 1, nodes: [...children.toReversed(), lane] });
    expect(flattenFleet(nodes, new Set()).map((row) => row.node.id)).toEqual([lane.id]);
    const expanded = new Set([lane.id]);
    const before = flattenFleet(nodes, expanded);
    const changed = {
      ...children[2]!,
      rev: 2,
      waiting: 1,
      tokens: { in: 84, out: 16, cached: 4, total: 100 },
    };
    const after = applyTreeBatch(nodes, { seq: 2, nodes: [changed] });
    expect(flattenFleet(after, expanded).map((row) => row.node.id)).toEqual([
      lane.id,
      changed.id,
      ...before.map((row) => row.node.id).filter((id) => id !== lane.id && id !== changed.id),
    ]);
    expect(after.get(children[0]!.id)).toBe(nodes.get(children[0]!.id));
    expect(
      fleetNeedsYou(after, [
        { environmentId: "remote", threadId: "thread", pendingRuntimeRequest: { id: "q" } },
      ]),
    ).toEqual(new Set([changed.id]));
    expect(
      fleetNeedsYou(after, [
        { environmentId: "home", threadId: "thread", pendingRuntimeRequest: { id: "q" } },
      ]),
    ).toEqual(new Set([changed.id, lane.id]));
  });
  it("drops settled nodes, ignores duplicate frames and accepts lower sequences after reset", () => {
    const first = applyFleetEvent(offlineFleet, {
      type: "snapshot",
      nodes: [lane],
      seq: 10,
      load: null,
      waiting: null,
    });
    const second = applyFleetEvent(first, {
      type: "delta",
      nodes: [{ ...lane, rev: 2, settled: true }],
      seq: 11,
    });
    expect(second.nodes.size).toBe(0);
    expect(applyFleetEvent(second, { type: "delta", seq: 10, nodes: [lane] })).toBe(second);
    expect(
      applyFleetEvent(second, { type: "delta", seq: 1, reset: true, nodes: [lane] }).nodes.get(
        lane.id,
      ),
    ).toBe(lane);
  });
  it("labels stopped, failed and last-known rows with their evidence", () => {
    const nodes = new Map([[lane.id, lane]]);
    expect(
      fleetRowLabels({ ...lane, state: "stopped", stateBy: "jared" }, nodes, false).state,
    ).toBe("Stopped by you");
    expect(
      fleetRowLabels({ ...lane, state: "stopped", stateBy: lane.id }, nodes, false).state,
    ).toBe("Stopped by Work");
    expect(
      fleetRowLabels({ ...lane, state: "failed", stateReason: "Process ended" }, nodes, false)
        .state,
    ).toBe("Process ended");
    expect(
      fleetRowLabels({ ...lane, state: "running", lastKnown: true }, nodes, false).state,
    ).toMatch(/Running · last seen 9:14/);
    expect(
      fleetRowLabels(
        { ...lane, tokens: null, tokensReason: "still-running", chat: null },
        nodes,
        false,
      ),
    ).toMatchObject({ tokens: "Still running", chat: "No chat attached" });
  });
});
