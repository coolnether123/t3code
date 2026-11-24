import type {
  ContextMenuItem,
  ContextMenuSource,
  EnvironmentId,
  OtisNode,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useEffect, useRef } from "react";
import { isContextMenuOpen } from "~/contextMenuFallback";
import { contextMenuSourceOf } from "~/contextMenuSource";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { toastManager } from "../../ui/toast";
import { readFleet, runFleetAction } from "./fleetData";

type Position = { x: number; y: number };

// Match the hold delay and motion tolerance of T3's usage button.
function useRowMenuTrigger(show: (position: Position, source: ContextMenuSource) => void) {
  const hold = useRef<{ start: Position; timer: ReturnType<typeof setTimeout> } | null>(null);
  const consumed = useRef(false);
  const cancel = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel an outstanding touch gesture on unmount.
  useEffect(
    () => () => {
      if (hold.current) clearTimeout(hold.current.timer);
    },
    [],
  );

  return {
    onPointerDown(event: React.PointerEvent<HTMLElement>) {
      cancel();
      consumed.current = false;
      if (event.pointerType !== "touch" || !event.isPrimary || event.button !== 0) return;
      const start = { x: event.clientX, y: event.clientY };
      hold.current = {
        start,
        timer: setTimeout(() => {
          cancel();
          consumed.current = true;
          show(start, "mouse");
        }, 550),
      };
    },
    onPointerMove(event: React.PointerEvent<HTMLElement>) {
      const start = hold.current?.start;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture(event: React.MouseEvent<HTMLElement>) {
      if (!consumed.current || event.detail === 0) return;
      consumed.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu(event: React.MouseEvent<HTMLElement>) {
      event.preventDefault();
      const touch =
        hold.current !== null ||
        ("pointerType" in event.nativeEvent && event.nativeEvent.pointerType === "touch");
      cancel();
      if (consumed.current && (window.desktopBridge || isContextMenuOpen())) return;
      consumed.current ||= touch;
      const source = contextMenuSourceOf(event);
      const rect =
        event.target instanceof HTMLElement ? event.target.getBoundingClientRect() : null;
      show(
        source === "keyboard" && rect
          ? { x: rect.left, y: rect.bottom }
          : { x: event.clientX, y: event.clientY },
        source,
      );
    },
    onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      show({ x: rect.left, y: rect.bottom }, "keyboard");
    },
  };
}

type MenuAction =
  | "open"
  | "copy-link"
  | "copy-run"
  | "seen"
  | "seen-all"
  | "retry"
  | "stop"
  | "stop-all";

export function useOtisRowMenu({
  node,
  environmentId,
  onOpen,
  canRetry = false,
  onWorkerAction,
}: {
  node: OtisNode | undefined;
  environmentId: EnvironmentId | null;
  onOpen: (node: OtisNode) => void;
  canRetry?: boolean;
  onWorkerAction?: (type: "seen" | "retry") => Promise<void>;
}) {
  const gt = useGT();
  const router = useRouter();
  const show = async (position: Position, source: ContextMenuSource) => {
    const api = readLocalApi();
    if (!api || !node) return;
    const { nodes } = readFleet();
    const lane = node.kind === "lane";
    const laneNode = lane ? node : nodes.get(`lane:${node.lane}`);
    const canWrite = !!environmentId && laneNode?.can.includes("child");
    const workers = lane
      ? [...nodes.values()].filter((child) => child.kind === "run" && child.lane === node.lane)
      : [];
    const failures = workers.filter((child) => child.state === "failed" && !child.seenAt);
    const running = workers.filter((child) =>
      ["queued", "starting", "running"].includes(child.state),
    );
    const canStopAll = running.length > 0 && running.every((child) => child.can.includes("stop"));
    const items: ContextMenuItem<MenuAction>[] = [];
    if (node.chat) items.push({ id: "open", label: lane ? gt("Open chat") : gt("Open") });
    if (lane) {
      if (canWrite && failures.length)
        items.push({ id: "seen-all", label: gt("Dismiss all failures") });
      if (node.chat) items.push({ id: "copy-link", label: gt("Copy link") });
      if (canWrite && canStopAll)
        items.push({ id: "stop-all", label: gt("Stop all workers…"), destructive: true });
    } else {
      if (node.kind === "run") items.push({ id: "copy-run", label: gt("Copy run ID") });
      if (canWrite && canRetry) items.push({ id: "retry", label: gt("Retry") });
      if (canWrite && node.state === "failed" && !node.seenAt)
        items.push({ id: "seen", label: gt("Dismiss") });
      if (environmentId && node.can.includes("stop"))
        items.push({ id: "stop", label: gt("Stop…"), destructive: true });
    }
    if (!items.length) return;
    try {
      const action = await api.contextMenu.show(items, position, source);
      if (action === "open") onOpen(node);
      if (action === "copy-run") await writeTextToClipboard(node.id);
      if (action === "copy-link" && node.chat) {
        const location =
          node.chat.host === "t3"
            ? router.buildLocation({
                to: "/$environmentId/$threadId",
                params: { environmentId: node.chat.environmentId, threadId: node.chat.threadId },
              })
            : router.buildLocation({ to: "/otis/node/$nodeId", params: { nodeId: node.id } });
        await writeTextToClipboard(new URL(location.href, window.location.href).href);
      }
      if ((action === "retry" || action === "seen") && onWorkerAction) {
        await onWorkerAction(action);
        return;
      }
      if (!environmentId) return;
      if (action === "seen") await runWorkerActions(environmentId, [node], "seen");
      if (action === "seen-all") {
        await runWorkerActions(environmentId, failures, "seen");
      }
      if (action === "stop" || action === "stop-all") {
        const targets = action === "stop" ? [node] : running;
        const names = targets.map((target) => `• ${target.title}`).join("\n");
        const confirmed = await api.dialogs.confirm(
          gt(
            "Stop these worker runs? This interrupts their current work and keeps their chat history.\n\n{names}",
            { names },
          ),
          { variant: "destructive" },
        );
        if (confirmed) await runWorkerActions(environmentId, targets, "stop");
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: gt("Could not complete the sidebar action"),
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
  };

  return useRowMenuTrigger((position, source) => void show(position, source));
}

async function runWorkerActions(
  environmentId: EnvironmentId,
  nodes: readonly OtisNode[],
  type: "seen" | "stop",
) {
  const results = await Promise.allSettled(
    nodes.map(({ id: nodeId }) =>
      runFleetAction(environmentId, {
        requestId: randomUUID(),
        nodeId,
        ...(type === "stop" ? { type, subtree: false } : { type }),
      }),
    ),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
