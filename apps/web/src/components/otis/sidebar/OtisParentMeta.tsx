import type { OtisNode } from "@t3tools/contracts";
import type { fleetRowLabels } from "@t3tools/client-runtime/otis/tree";
import { useGT, useLocale } from "gt-react";
import { Info } from "lucide-react";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../ui/popover";

function hasParentModel(node: OtisNode) {
  return node.modelEvidence !== null || node.model !== "No model assigned";
}

export function OtisParentTurnDot({ node }: { node: OtisNode }) {
  const gt = useGT();
  return node.state === "running" ? (
    <span
      role="img"
      aria-label={gt("Parent turn running")}
      className="size-2 shrink-0 rounded-full bg-success"
    />
  ) : null;
}

export function OtisParentMeta({ node, model }: { node: OtisNode; model: string }) {
  const gt = useGT();
  const locale = useLocale();
  const amount = node.costSource === "api-equivalent-t3" ? node.costUsd : null;
  const currency =
    amount === null
      ? null
      : new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          ...(amount >= 1000 ? { notation: "compact", maximumFractionDigits: 1 } : {}),
        }).format(amount);
  return (
    <span
      data-otis-parent-meta=""
      className="@container/otis-parent-meta -me-1 flex items-baseline gap-x-px text-xs text-sidebar-foreground/80 tabular-nums"
    >
      <span className="min-w-[3ch] truncate">{hasParentModel(node) ? model : gt("No model")}</span>
      <span aria-hidden="true">·</span>
      <span className="whitespace-nowrap">
        {currency === null ? (
          <>
            <span aria-hidden="true">{gt("Unknown")}</span>
            <span className="sr-only">{gt("Cost unknown")}</span>
          </>
        ) : (
          <>
            <span aria-hidden="true" className="@min-[12rem]/otis-parent-meta:hidden">
              ≈{currency}
            </span>
            <span className="sr-only @min-[12rem]/otis-parent-meta:not-sr-only">
              {gt("{cost} today", { cost: `≈${currency}` })}
            </span>
          </>
        )}
      </span>
      <span aria-hidden="true">·</span>
      <span className="whitespace-nowrap">
        <span aria-hidden="true">{gt("{count} running", { count: node.sub.running })}</span>
        <span className="sr-only">
          {gt("Running workers: {count}", { count: node.sub.running })}
        </span>
      </span>
    </span>
  );
}

export function OtisParentStatus({ node }: { node: OtisNode }) {
  const gt = useGT();
  const needsYou = node.waiting + node.sub.waiting;
  return (
    <>
      {needsYou > 0 && (
        <span className="whitespace-nowrap rounded-full bg-warning-surface px-1 text-xs font-semibold text-warning-foreground tabular-nums">
          {gt("{count} needs you", { count: needsYou })}
        </span>
      )}
      {node.sub.failedUnseen > 0 && (
        <span className="whitespace-nowrap rounded-full bg-error-surface px-1 text-xs font-semibold text-error-foreground tabular-nums">
          <span aria-hidden="true">{gt("{count} failed", { count: node.sub.failedUnseen })}</span>
          <span className="sr-only">
            {gt("{count} failures to dismiss", { count: node.sub.failedUnseen })}
          </span>
        </span>
      )}
    </>
  );
}

export function OtisParentDetails({
  node,
  labels,
  title,
  question,
}: {
  node: OtisNode;
  labels: ReturnType<typeof fleetRowLabels>;
  title: string;
  question?: string | undefined;
}) {
  const gt = useGT();
  const locale = useLocale();
  const cost =
    node.costUsd === null || node.costSource === "unpriced"
      ? null
      : new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 20,
        }).format(node.costUsd);
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        data-fleet-action=""
        aria-label={gt("Details for {title}", { title })}
        className="grid size-6 shrink-0 place-items-center any-pointer-coarse:size-11"
      >
        <Info aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup side="right" align="start" width="sm" padding="compact" touchBackdrop>
        <PopoverTitle>
          <span className="wrap-anywhere">{title}</span>
        </PopoverTitle>
        <div className="mt-1 space-y-1 text-xs wrap-anywhere text-muted-foreground">
          {question && <div>{question}</div>}
          <div>
            {hasParentModel(node) ? node.model : gt("No model assigned")} ·{" "}
            {labels.state || gt("Idle")}
          </div>
          <div>
            {cost === null
              ? gt("Cost unknown")
              : node.costSource === "api-equivalent-t3"
                ? gt("API-equivalent estimate today: {cost}", { cost })
                : node.costSource === "provider"
                  ? gt("Provider-reported cost: {cost} (period unknown)", { cost })
                  : gt("Estimated cost: {cost} (period unknown)", { cost })}
          </div>
          {node.sub.failedUnseen > 0 && (
            <div>{gt("{count} failures to dismiss", { count: node.sub.failedUnseen })}</div>
          )}
          {node.tokens && (
            <div>
              {gt("{tokens} tokens today", {
                tokens: new Intl.NumberFormat(locale).format(node.tokens.total),
              })}
            </div>
          )}
          {node.sub.queued !== undefined && node.sub.queued > 0 && (
            <div>{gt("{count} queued", { count: node.sub.queued })}</div>
          )}
          {node.sub.done !== undefined && <div>{gt("{count} done", { count: node.sub.done })}</div>}
          {node.sub.failed !== undefined && node.sub.failed > 0 && (
            <div>{gt("{count} failed since the parent started", { count: node.sub.failed })}</div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
