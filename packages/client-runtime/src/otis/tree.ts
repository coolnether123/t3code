import type { OtisFleetEvent, OtisNode, OtisTreeBatch, OtisWaiting } from "@t3tools/contracts";

type Load = Extract<OtisFleetEvent, { type: "load" }>["load"];
export interface FleetState {
  readonly sidebar: "stock" | "otis";
  readonly explanation: string | null;
  readonly nodes: ReadonlyMap<string, OtisNode>;
  readonly seq: number;
  readonly waiting: typeof OtisWaiting.Type | null;
  readonly load: Load | null;
}
export const offlineFleet: FleetState = {
  sidebar: "stock",
  explanation: "Otis is not answering. Showing all chats.",
  nodes: new Map(),
  seq: -1,
  waiting: null,
  load: null,
};

export function applyTreeBatch(current: ReadonlyMap<string, OtisNode>, batch: OtisTreeBatch) {
  const nodes = batch.reset ? new Map<string, OtisNode>() : new Map(current);
  for (const node of batch.nodes) {
    const previous = nodes.get(node.id);
    if (previous && previous.rev >= node.rev) continue;
    if (node.settled) nodes.delete(node.id);
    else nodes.set(node.id, node);
  }
  return nodes;
}
export function applyFleetEvent(state: FleetState, event: OtisFleetEvent): FleetState {
  switch (event.type) {
    case "unavailable":
      return offlineFleet;
    case "snapshot":
      return {
        sidebar: "otis",
        explanation: null,
        seq: event.seq,
        nodes: applyTreeBatch(offlineFleet.nodes, event),
        waiting: event.waiting,
        load: event.load,
      };
    case "delta":
      if (state.sidebar === "stock" || (!event.reset && event.seq <= state.seq)) return state;
      return { ...state, seq: event.seq, nodes: applyTreeBatch(state.nodes, event) };
    case "load":
      return { ...state, load: event.load };
    case "waiting":
      return { ...state, waiting: event.waiting };
  }
}

function priority(node: OtisNode) {
  if (node.waiting + node.sub.waiting) return 0;
  if (node.sub.running || node.sub.queued || ["running", "queued", "starting"].includes(node.state))
    return 1;
  return node.state === "failed" ? 2 : 3;
}

export function flattenFleet(nodes: ReadonlyMap<string, OtisNode>, expanded: ReadonlySet<string>) {
  const children = new Map<string | null, OtisNode[]>();
  for (const node of nodes.values()) {
    if (node.settled || (node.parent !== null && !expanded.has(node.parent))) continue;
    const group = children.get(node.parent);
    if (group) group.push(node);
    else children.set(node.parent, [node]);
  }
  const rows: { node: OtisNode; depth: number }[] = [];
  const visit = (parent: string | null, depth: number) => {
    const group = children.get(parent);
    if (!group) return;
    group.sort(
      (a, b) =>
        priority(a) - priority(b) ||
        (parent === null
          ? (a.order ?? 0) - (b.order ?? 0)
          : Date.parse(a.startedAt) - Date.parse(b.startedAt)) ||
        (a.id < b.id ? -1 : Number(a.id > b.id)),
    );
    for (const node of group) {
      rows.push({ node, depth });
      if (expanded.has(node.id)) visit(node.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

export interface NativeFleetThread {
  readonly environmentId: string;
  readonly threadId: string;
  readonly pendingRuntimeRequest: { readonly id: string } | null;
}
export function fleetNeedsYou(
  nodes: ReadonlyMap<string, OtisNode>,
  threads: Iterable<NativeFleetThread>,
) {
  const pending = new Map<string, Set<string>>();
  for (const thread of threads) {
    if (!thread.pendingRuntimeRequest) continue;
    let ids = pending.get(thread.environmentId);
    if (!ids) pending.set(thread.environmentId, (ids = new Set()));
    ids.add(thread.threadId);
  }
  const result = new Set<string>();
  for (const node of nodes.values()) {
    if (
      node.waiting ||
      (node.chat?.host === "t3" && pending.get(node.chat.environmentId)?.has(node.chat.threadId))
    ) {
      result.add(node.id);
    }
  }
  return result;
}

const shortTokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const chicagoTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "numeric",
  minute: "2-digit",
});

export function fleetParentCost(
  node: Pick<OtisNode, "costUsd" | "costSource" | "tokens" | "apiUsage">,
) {
  if (node.costUsd !== null && node.costSource !== "unpriced") {
    return { kind: node.costSource, usd: node.costUsd } as const;
  }
  if ((node.apiUsage?.records ?? 0) > 0 || (node.tokens?.total ?? 0) > 0) {
    return { kind: "unpriced" } as const;
  }
  return { kind: node.tokens === null ? "unknown" : "no-usage" } as const;
}

export function fleetRowLabels(
  node: OtisNode,
  nodes: ReadonlyMap<string, OtisNode>,
  collapsed: boolean,
) {
  const states = {
    queued: "Queued",
    starting: "Starting",
    running: "Running",
    idle: "",
    done: "Done",
    failed:
      !node.stateReason || /\[redact|native[ _-]exit[ _-]nonzero/i.test(node.stateReason)
        ? "Worker exited before finishing"
        : node.stateReason,
    stopped:
      node.stateBy === "jared"
        ? "Stopped by you"
        : `Stopped by ${nodes.get(node.stateBy ?? "")?.title ?? "parent"}`,
  };
  const state = states[node.state];
  const total = node.tokens?.total;
  const descendants = node.kind !== "lane" && collapsed ? node.sub.tokens : 0;
  return {
    title: node.title,
    model: /opus[- .](\d+)[- .](\d+)/i.test(node.model)
      ? node.model.replace(/^.*opus[- .](\d+)[- .](\d+).*$/i, "Opus $1.$2")
      : (["Fable", "Sol", "Astra", "Neon"].find((name) =>
          node.model
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .includes(name.toLowerCase()),
        ) ?? node.model),
    state: node.lastKnown
      ? [state, `last seen ${chicagoTime.format(Date.parse(node.observedAt))}`]
          .filter(Boolean)
          .join(" · ")
      : state,
    tokens:
      total !== undefined || descendants > 0
        ? shortTokens.format((total ?? 0) + descendants).replace("K", "k")
        : node.tokensReason === "still-running"
          ? "Still running"
          : "Provider does not report tokens",
    chat: node.chat === null ? "No chat attached" : null,
  };
}
