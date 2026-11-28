import { useGT } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import {
  EnvironmentId,
  ThreadId,
  OTIS_THREAD_ID,
  type OtisNode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { fleetRowLabels, flattenFleet, type FleetState } from "@t3tools/client-runtime/otis/tree";
import { isElectron } from "~/env";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useStableCallback } from "~/hooks/useStableCallback";
import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { useThreadRefs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";
import { SidebarChromeHeader } from "../../sidebar/SidebarChrome";
import { useSidebar, useSidebarVisibility } from "../../ui/sidebar";
import { OtisButton } from "../OtisButton";
import { OtisPlanStrip } from "./OtisPlanStrip";
import { OtisDoneFold } from "./OtisDoneFold";
import { OtisTreeRow, OtisRowMeta } from "./OtisTreeRow";
import { OtisParentDetails, OtisParentTurnDot } from "./OtisParentMeta";
import { useOtisRowMenu } from "./useOtisRowMenu";
import { readWorkerNodes, useFleet } from "./fleetData";
import { useConnectingParents } from "./MakeParent";
import "./fleet.css";

const ids = Schema.Array(Schema.String);
const noIds: readonly string[] = [];

function FleetList({
  fleet,
  environmentId,
  onOtherChats,
}: {
  fleet: FleetState;
  environmentId: EnvironmentId;
  onOtherChats: () => void;
}) {
  const gt = useGT();
  const [expandedIds, setExpanded] = useLocalStorage(
    "otis.fleet.expanded." + environmentId,
    noIds,
    ids,
  );
  const [phonePath, setPhonePath] = useLocalStorage(
    "otis.fleet.phonePath." + environmentId,
    noIds,
    ids,
  );
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const threadRefs = useThreadRefs();
  const connecting = useConnectingParents(fleet.nodes);
  const nodes = fleet.nodes;
  const path = phonePath.filter((id) => nodes.has(id));
  const parent = isMobile ? nodes.get(path.at(-1) ?? "") : undefined;
  const parentLabels = parent && fleetRowLabels(parent, nodes, false);
  const expanded = new Set(isMobile ? path : expandedIds);
  const rows = flattenFleet(nodes, expanded);
  const visibleTreeNodes = new Set(rows.map(({ node }) => node.id));
  const [workersExpanded, setWorkersExpanded] = useState(false);
  const workersId = useId();
  const [featuredWorkers, setFeaturedWorkers] = useState<readonly OtisNode[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read the configured worker shortcuts from the current environment.
  useEffect(() => {
    const controller = new AbortController();
    void readWorkerNodes(environmentId, { featuredWorkers: true }, controller.signal).then(
      (workers) => {
        if (!controller.signal.aborted) setFeaturedWorkers(workers);
      },
      () => {},
    );
    return () => controller.abort();
  }, [environmentId]);
  const featuredIds = new Set(featuredWorkers.map((node) => node.id));
  const workers = featuredWorkers
    .map((node) => nodes.get(node.id) ?? node)
    .concat(
      [...nodes.values()].filter(
        (node) =>
          node.kind === "run" &&
          node.chat?.host === "otis" &&
          node.chat.threadId &&
          !node.settled &&
          !featuredIds.has(node.id) &&
          (node.state === "running" || node.state === "idle") &&
          (isMobile || !visibleTreeNodes.has(node.id)),
      ),
    );
  const children = new Map<string, { count: number; represented: number }>();
  const bound = new Set<string>();
  for (const node of nodes.values()) {
    if (node.parent !== null) {
      const group = children.get(node.parent) ?? { count: 0, represented: 0 };
      children.set(node.parent, {
        count: group.count + 1,
        represented: group.represented + node.sub.nodes + 1,
      });
    }
    if (node.chat?.host === "t3")
      bound.add(
        scopedThreadKey(
          scopeThreadRef(
            EnvironmentId.make(node.chat.environmentId),
            ThreadId.make(node.chat.threadId),
          ),
        ),
      );
  }
  const otherCount = threadRefs.filter(
    (ref) => ref.threadId !== OTIS_THREAD_ID && !bound.has(scopedThreadKey(ref)),
  ).length;
  const questions = new Map<string, string>();
  for (const lane of fleet.waiting?.lanes ?? []) {
    for (const item of [...lane.requests, ...lane.approvals]) {
      if (item.nodeId && item.title && !questions.has(item.nodeId))
        questions.set(item.nodeId, item.title);
    }
  }
  const openRef = (ref: ScopedThreadRef) => {
    if (isMobile) setOpenMobile(false);
    return navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
  const open = useStableCallback((node: OtisNode) => {
    if (node.chat?.host === "t3")
      void openRef(
        scopeThreadRef(
          EnvironmentId.make(node.chat.environmentId),
          ThreadId.make(node.chat.threadId),
        ),
      );
    if (node.chat?.host === "otis") {
      if (isMobile) setOpenMobile(false);
      void navigate({ to: "/otis/node/$nodeId", params: { nodeId: node.id } });
    }
  });
  const parentMenu = useOtisRowMenu({ node: parent, environmentId, onOpen: open });
  const expand = useStableCallback((id: string) => {
    if (isMobile) setPhonePath([...path, id]);
    else
      setExpanded((previous) =>
        previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
      );
  });
  const done = (node: OtisNode, depth: number) => {
    const missing = node.sub.nodes - (children.get(node.id)?.represented ?? 0);
    return missing > 0 ? (
      <OtisDoneFold
        key={`done:${node.id}:${missing}`}
        environmentId={environmentId}
        parent={node.id}
        onOpen={open}
        depth={depth}
      />
    ) : null;
  };
  const items: ReactNode[] = [];
  const ancestors: { node: OtisNode; depth: number }[] = [];
  const closeGroups = (depth: number) => {
    while (ancestors.length && ancestors[ancestors.length - 1]!.depth >= depth) {
      const row = ancestors.pop()!;
      items.push(done(row.node, row.depth + 1));
    }
  };
  for (const { node, depth } of rows) {
    if (isMobile && node.parent !== (parent?.id ?? null)) continue;
    closeGroups(depth);
    items.push(
      <OtisTreeRow
        key={node.id}
        node={node}
        {...fleetRowLabels(node, nodes, !expanded.has(node.id))}
        depth={depth}
        narrow={isMobile}
        expanded={expanded.has(node.id)}
        childCount={children.get(node.id)?.count ?? 0}
        question={questions.get(node.id)}
        onExpand={expand}
        onOpen={open}
      />,
    );
    if (!isMobile && expanded.has(node.id)) ancestors.push({ node, depth });
  }
  closeGroups(0);
  if (parent) items.push(done(parent, 0));
  return (
    <section
      aria-label={gt("Otis fleet")}
      className="flex h-full min-h-0 flex-col bg-sidebar text-sm text-sidebar-foreground"
    >
      {parent && parentLabels ? (
        <header
          {...parentMenu}
          className="border-b px-2 py-1 select-none [-webkit-touch-callout:none]"
        >
          <div className="flex items-center">
            <button
              data-fleet-link=""
              className="min-w-0 flex-1"
              onClick={() => setPhonePath(path.slice(0, -1))}
              aria-label={gt("Back from {title}", { title: parent.title })}
            >
              <ChevronLeft size={16} className="shrink-0" />
              {parent.kind === "lane" && <OtisParentTurnDot node={parent} />}
              <span className="truncate">{path.map((id) => nodes.get(id)?.title).join(" / ")}</span>
            </button>
            {parent.kind === "lane" && (
              <OtisParentDetails node={parent} labels={parentLabels} title={parent.title} />
            )}
          </div>
          <div className="px-3">
            <OtisRowMeta node={parent} labels={parentLabels} />
          </div>
          {parent.chat && (
            <button data-fleet-link="" aria-haspopup="menu" onClick={() => open(parent)}>
              {gt("Open chat")}
            </button>
          )}
        </header>
      ) : (
        <header className="flex items-center justify-between border-b px-2">
          <div className="min-w-0 flex-1">
            <SidebarChromeHeader isElectron={isElectron} />
          </div>
          <div className="shrink-0">
            <OtisButton environmentId={environmentId} onOpen={openRef} />
          </div>
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {!parent && (
          <OtisPlanStrip
            environmentId={environmentId}
            onOpen={() => {
              setOpenMobile(false);
              void navigate({ to: "/usage-resets", hash: "plans" });
            }}
          />
        )}
        {!parent && workers.length > 0 && (
          <section aria-label={gt("Otis workers")} className="mb-2 border-b pb-2">
            <h2>
              <button
                type="button"
                data-fleet-link=""
                className="text-xs font-medium text-muted-foreground"
                aria-expanded={workersExpanded}
                aria-controls={workersId}
                onClick={() => setWorkersExpanded(!workersExpanded)}
              >
                {workersExpanded ? (
                  <ChevronDown size={14} aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} aria-hidden="true" />
                )}
                {gt("Otis workers")}
              </button>
            </h2>
            <div id={workersId} hidden={!workersExpanded}>
              {workers.map((node) => (
                <button
                  key={node.id}
                  data-fleet-link=""
                  className="min-w-0"
                  onClick={() => open(node)}
                >
                  <span className="truncate">{node.title}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {connecting
          .filter(
            (row) =>
              row.environmentId === environmentId &&
              !bound.has(scopedThreadKey(scopeThreadRef(environmentId, row.threadId))),
          )
          .map((row) => (
            <button
              key={row.threadId}
              data-fleet-link=""
              onClick={() => void openRef(scopeThreadRef(environmentId, row.threadId))}
            >
              {row.title} · {gt("Connecting")}
            </button>
          ))}
        {items}
        {!items.length && !parent && (
          <p className="px-2 text-muted-foreground">{gt("No fleet nodes yet.")}</p>
        )}
      </div>
      <footer className="border-t p-1">
        <button data-fleet-link="" className="justify-between" onClick={onOtherChats}>
          {gt("Other chats · {count}", { count: otherCount })}
          <ChevronRight size={14} />
        </button>
      </footer>
    </section>
  );
}

export function OtisSidebar({ children }: { children: ReactNode }) {
  const gt = useGT();
  const fleet = useFleet();
  const environmentId = usePrimaryEnvironmentId();
  const [other, setOther] = useLocalStorage("otis.fleet.otherChats", false, Schema.Boolean);
  const visible = useSidebarVisibility();
  const activity = useSyncExternalStore(subscribeDocumentActivity, getDocumentActivity);
  if (!environmentId || other || fleet.sidebar === "stock")
    return (
      <>
        {environmentId &&
          (fleet.sidebar === "stock" ? (
            <div
              role="status"
              className="shrink-0 border-b px-3 py-1 text-xs text-muted-foreground"
            >
              {gt("Otis tree unavailable. Showing all chats.")}
            </div>
          ) : (
            <button
              data-fleet-link=""
              className="shrink-0 border-b"
              onClick={() => setOther(false)}
            >
              <ChevronLeft size={14} />
              {gt("Back to Otis fleet")}
            </button>
          ))}
        {children}
      </>
    );
  return visible && activity.visible ? (
    <FleetList
      key={environmentId}
      fleet={fleet}
      environmentId={environmentId}
      onOtherChats={() => setOther(true)}
    />
  ) : null;
}
