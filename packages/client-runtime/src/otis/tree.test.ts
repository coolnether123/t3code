import { describe, expect, it } from "vitest";
import type { OtisNode } from "@t3tools/contracts";
import {
  applyFleetEvent,
  applyTreeBatch,
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
  it("keeps all 499 children behind their fold, then preserves order as attention and usage change", () => {
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
    expect(flattenFleet(after, expanded).map((row) => row.node.id)).toEqual(
      before.map((row) => row.node.id),
    );
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
