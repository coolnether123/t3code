import { FleetTitle } from "./FleetTitle";
import { useGT } from "gt-react";
import type { OtisNode } from "@t3tools/contracts";
import { ChevronDown, ChevronRight, Check, X, Square } from "lucide-react";
import type { fleetRowLabels } from "@t3tools/client-runtime/otis/tree";
import { memo } from "react";

interface Props extends ReturnType<typeof fleetRowLabels> {
  node: OtisNode;
  depth: number;
  narrow: boolean;
  expanded: boolean;
  childCount: number;
  question?: string | undefined;
  onExpand: (id: string) => void;
  onOpen: (node: OtisNode) => void;
}

function StateMark({ node, label }: { node: OtisNode; label: string }) {
  const gt = useGT();
  const Icon =
    node.state === "failed"
      ? X
      : node.state === "done"
        ? Check
        : node.state === "stopped"
          ? Square
          : null;
  if (!node.waiting && Icon)
    return (
      <Icon
        aria-label={label}
        className={node.state === "failed" ? "size-3 text-destructive" : "size-3"}
      />
    );
  const color = node.waiting
    ? "bg-warning"
    : node.state === "running"
      ? "bg-success"
      : node.state === "idle"
        ? "bg-muted-foreground/70"
        : "border border-muted-foreground";
  return (
    <span
      role="img"
      aria-label={node.waiting ? gt("Needs you") : label || gt("Idle")}
      className={`mx-0.5 size-2 shrink-0 rounded-full ${color}`}
    />
  );
}

export const OtisTreeRow = memo(function OtisTreeRow({
  node,
  depth,
  narrow,
  expanded,
  childCount,
  question,
  onExpand,
  onOpen,
  ...labels
}: Props) {
  const gt = useGT();
  const lane = node.kind === "lane";
  const branch = !node.settled && (node.sub.nodes > 0 || childCount > 0);
  const needs = node.sub.waiting + node.waiting;
  const summary = [
    narrow ? null : labels.model,
    expanded ? null : node.sub.running ? gt("{count} running", { count: node.sub.running }) : null,
    expanded || !needs ? null : gt("{count} needs you", { count: needs }),
    !expanded && !needs && !node.sub.running ? labels.state || gt("Idle") : null,
    node.tokens && expanded ? gt("{tokens} today", { tokens: labels.tokens }) : labels.tokens,
  ]
    .filter(Boolean)
    .join(" · ");
  const childDetail =
    question ||
    (node.lastKnown || ["failed", "stopped"].includes(node.state)
      ? labels.state
      : node.waiting
        ? node.waiting === 1
          ? gt("Needs you")
          : gt("{count} need you", { count: node.waiting })
        : node.state === "running"
          ? labels.model + " · " + labels.tokens
          : null);
  const detail = lane ? summary : childDetail;
  const drill = branch && (narrow || node.chat?.host !== "t3");
  const action = drill
    ? () => onExpand(node.id)
    : node.chat?.host === "t3"
      ? () => onOpen(node)
      : undefined;
  const name = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {!lane && <StateMark node={node} label={labels.state} />}
        {depth > 4 && !narrow && <small>{depth}</small>}
        <FleetTitle title={node.title} detail={detail} />
      </span>
      {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
    </>
  );
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div
      data-fleet-row=""
      className={`flex min-w-0 items-center gap-1 rounded-md px-2 ${detail || narrow ? "h-11" : "h-7"}`}
      style={{ paddingInlineStart: 8 + (narrow ? 0 : Math.min(depth, 4) * 12) }}
    >
      {branch && !narrow && (
        <button
          data-fleet-action=""
          className="shrink-0"
          aria-label={
            expanded
              ? gt("Collapse {title}", { title: node.title })
              : gt("Expand {title}", { title: node.title })
          }
          aria-expanded={expanded}
          onClick={() => onExpand(node.id)}
        >
          <Chevron size={14} />
        </button>
      )}
      {action ? (
        <button
          data-fleet-action=""
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={action}
        >
          <span className="min-w-0 flex-1">{name}</span>
          {narrow && branch && <ChevronRight size={14} aria-hidden="true" />}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{name}</div>
      )}
      {branch && !expanded && !lane && childCount > 0 && (
        <span className="text-xs text-muted-foreground">{childCount}</span>
      )}
    </div>
  );
});
