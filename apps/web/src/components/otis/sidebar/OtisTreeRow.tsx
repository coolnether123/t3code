import { FleetTitle } from "./FleetTitle";
import { useGT } from "gt-react";
import { randomUUID } from "~/lib/utils";
import type { OtisNode } from "@t3tools/contracts";
import { ChevronDown, ChevronRight, Check, X, Square } from "lucide-react";
import type { fleetRowLabels } from "@t3tools/client-runtime/otis/tree";
import { useRelativeTimeState } from "~/hooks/useRelativeTimeState";
import { useOtisRowMenu } from "./useOtisRowMenu";
import { runFleetAction } from "./fleetData";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { Fragment, memo, useRef, useState } from "react";

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

export function NeedsYouPill({ node }: { node: OtisNode }) {
  const gt = useGT();
  const count = node.waiting + node.sub.waiting;
  return count > 0 ? (
    <span className="ml-auto shrink-0 rounded-full bg-warning-surface px-2 text-xs font-semibold text-warning-foreground">
      {gt("{count} needs you", { count })}
    </span>
  ) : null;
}

export function OtisRowMeta({
  node,
  labels,
}: {
  node: OtisNode;
  labels: ReturnType<typeof fleetRowLabels>;
}) {
  const gt = useGT();
  const lane = node.kind === "lane";
  const counts = [
    node.sub.running && gt("{count} running", { count: node.sub.running }),
    node.sub.queued && gt("{count} queued", { count: node.sub.queued }),
    node.sub.failedUnseen && gt("{count} failed", { count: node.sub.failedUnseen }),
    node.sub.done && gt("{count} done", { count: node.sub.done }),
  ].filter(Boolean);
  const age = useRelativeTimeState(lane ? null : (node.endedAt ?? node.startedAt));
  const elapsed = age.status === "relative" ? (node.endedAt ? age.label : age.value) : null;
  const detail = [
    labels.model,
    lane
      ? counts.length > 0
        ? counts.map((count) => <span className="whitespace-nowrap">{count}</span>)
        : labels.state || gt("Idle")
      : node.waiting
        ? gt("Needs you")
        : labels.state || gt("Idle"),
    elapsed,
  ]
    .flat()
    .filter(Boolean);
  const cost =
    node.costSource !== "api-equivalent-t3" || node.costUsd == null
      ? // oxlint-disable-next-line t3code/no-em-dash-copy -- Specified missing-value glyph in the cost column.
        "—"
      : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(node.costUsd);
  const metrics = [
    cost,
    node.tokens && (lane ? gt("{tokens} today", { tokens: labels.tokens }) : labels.tokens),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="flex items-baseline justify-between gap-1 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">
        {detail.map((part, index) => (
          <Fragment key={index}>
            {index > 0 && " · "}
            {part}
          </Fragment>
        ))}
      </span>
      <span
        className="shrink-0 whitespace-nowrap text-right tabular-nums"
        aria-label={gt("API-equivalent cost and tokens: {metrics}", { metrics })}
      >
        {metrics}
      </span>
    </span>
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
  const environmentId = usePrimaryEnvironmentId();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ type: "seen" | "retry"; id: string } | null>(null);
  const title = question || labels.title;
  const failedAt = node.state === "failed" ? (node.endedAt ?? node.observedAt) : null;
  const failureAge = useRelativeTimeState(failedAt);
  const retryWindowMs = 24 * 60 * 60 * 1000;
  const canRetry =
    node.kind === "run" &&
    labels.model !== "Neon" &&
    failureAge.status === "relative" &&
    failureAge.elapsedMs < retryWindowMs;
  async function runAction(type: "retry" | "seen") {
    if (!environmentId || sending) return;
    if (
      type === "retry" &&
      (!canRetry || failedAt === null || Date.now() - Date.parse(failedAt) >= retryWindowMs)
    )
      return;
    setSending(true);
    setError("");
    if (attempt.current?.type !== type) attempt.current = { type, id: randomUUID() };
    try {
      await runFleetAction(environmentId, { type, nodeId: node.id, requestId: attempt.current.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Otis could not confirm the action."));
    } finally {
      setSending(false);
    }
  }
  const menu = useOtisRowMenu({ node, environmentId, onOpen, canRetry, onWorkerAction: runAction });
  const action = node.chat ? () => onOpen(node) : branch ? () => onExpand(node.id) : undefined;
  const name = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {!lane && <StateMark node={node} label={labels.state} />}
        <FleetTitle
          title={title}
          detail={[labels.model, labels.state].filter(Boolean).join(" \u00b7 ")}
        />
        {lane && <NeedsYouPill node={node} />}
      </span>
      <OtisRowMeta node={node} labels={labels} />
    </>
  );
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <div
        {...menu}
        data-fleet-row=""
        className={`flex min-w-0 items-center gap-1 rounded-md px-2 min-h-11 select-none [-webkit-touch-callout:none]`}
        style={{ paddingInlineStart: 8 + (narrow ? 0 : Math.min(depth, 4) * 12) }}
      >
        {branch ? (
          <button
            data-fleet-action=""
            className="grid w-6 shrink-0 place-items-center self-stretch"
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
        ) : (
          <span className="w-6 shrink-0" aria-hidden="true" />
        )}
        {action ? (
          <button
            data-fleet-action=""
            className="flex min-w-0 flex-1 self-stretch items-center gap-1 text-left"
            aria-haspopup="menu"
            onClick={action}
          >
            <span className="min-w-0 flex-1">{name}</span>
          </button>
        ) : (
          <div
            tabIndex={0}
            className="min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-ring"
          >
            {name}
          </div>
        )}
        {branch && !expanded && !lane && childCount > 0 && (
          <span className="text-xs text-muted-foreground">{childCount}</span>
        )}
      </div>
      {node.state === "failed" && !node.seenAt && (
        <div className="flex justify-end gap-3 px-2 text-xs">
          {canRetry && (
            <button data-fleet-action="" disabled={sending} onClick={() => void runAction("retry")}>
              {gt("Retry")}
            </button>
          )}
          <button data-fleet-action="" disabled={sending} onClick={() => void runAction("seen")}>
            {gt("Dismiss")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
});
