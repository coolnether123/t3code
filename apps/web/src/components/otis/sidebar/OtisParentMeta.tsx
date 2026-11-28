import type { OtisNode } from "@t3tools/contracts";
import { fleetParentCost, type fleetRowLabels } from "@t3tools/client-runtime/otis/tree";
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
  const cost = fleetParentCost(node);
  const running = node.sub.running;
  const activity =
    running > 0
      ? gt("{count} running", { count: running })
      : node.state === "running"
        ? gt("Working")
        : null;
  const costLabel =
    cost.kind === "api-equivalent-t3"
      ? `≈${new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          ...(cost.usd >= 1000 ? { notation: "compact", maximumFractionDigits: 1 } : {}),
        }).format(cost.usd)}`
      : cost.kind === "unpriced"
        ? gt("Unpriced")
        : cost.kind === "no-usage"
          ? gt("No usage today")
          : cost.kind === "unknown"
            ? gt("Unknown")
            : gt("Period unknown");
  return (
    <span
      data-otis-parent-meta=""
      className="@container/otis-parent-meta -me-1 block text-xs text-sidebar-foreground/80 tabular-nums"
    >
      <span className="flex flex-wrap items-baseline gap-x-px @min-[15em]/otis-parent-meta:flex-nowrap">
        <span data-otis-parent-metric="" className="min-w-[3ch] max-w-full truncate">
          {hasParentModel(node) ? model : gt("No model")}
        </span>
        <span className="inline-flex max-w-full shrink-0 items-baseline gap-x-px">
          <span aria-hidden="true">·</span>
          {cost.kind === "api-equivalent-t3" ? (
            <span data-otis-parent-metric="" className="whitespace-nowrap">
              <span aria-hidden="true" className="@min-[12rem]/otis-parent-meta:hidden">
                {costLabel}
              </span>
              <span className="sr-only @min-[12rem]/otis-parent-meta:not-sr-only">
                {gt("{cost} today", { cost: costLabel })}
              </span>
            </span>
          ) : (
            <span data-otis-parent-metric="">{costLabel}</span>
          )}
        </span>
        {activity !== null && (
          <span className="inline-flex shrink-0 items-baseline gap-x-px whitespace-nowrap">
            <span aria-hidden="true">·</span>
            <span data-otis-parent-metric="">{activity}</span>
          </span>
        )}
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
  title,
  node,
  labels,
  question,
  descriptionId,
}: {
  title: string;
  node: OtisNode;
  labels: ReturnType<typeof fleetRowLabels>;
  question?: string | undefined;
  descriptionId?: string | undefined;
}) {
  const gt = useGT();
  const locale = useLocale();
  const cost = fleetParentCost(node);
  const currency =
    "usd" in cost
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 20,
        }).format(cost.usd)
      : "";
  const costLabels = {
    "api-equivalent-t3": () => gt("API-equivalent estimate today: {cost}", { cost: currency }),
    provider: () => gt("Provider-reported cost: {cost} (period unknown)", { cost: currency }),
    priced: () => gt("Estimated cost: {cost} (period unknown)", { cost: currency }),
    unpriced: () => gt("Unpriced usage today"),
    "no-usage": () => gt("No usage today"),
    unknown: () => gt("Cost unknown"),
  };
  const facts = {
    question,
    modelAndState: `${hasParentModel(node) ? node.model : gt("No model assigned")} · ${labels.state || gt("Idle")}`,
    cost: costLabels[cost.kind](),
    estimateNote:
      cost.kind === "api-equivalent-t3" || cost.kind === "priced"
        ? gt("The estimate may exclude unpriced usage.")
        : null,
    running: gt("Running workers: {count}", { count: node.sub.running }),
    unseen:
      node.sub.failedUnseen > 0
        ? gt("{count} failures to dismiss", { count: node.sub.failedUnseen })
        : null,
    tokens: node.tokens
      ? gt("{tokens} tokens today", {
          tokens: new Intl.NumberFormat(locale).format(node.tokens.total),
        })
      : null,
    queued: node.sub.queued ? gt("{count} queued", { count: node.sub.queued }) : null,
    done: node.sub.done === undefined ? null : gt("{count} done", { count: node.sub.done }),
    failed: node.sub.failed
      ? gt("{count} failed since the parent started", { count: node.sub.failed })
      : null,
  };
  return (
    <>
      {descriptionId && (
        <div hidden id={descriptionId}>
          {Object.values(facts).filter(Boolean).join(" · ")}
        </div>
      )}
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
            {Object.entries(facts).map(([key, line]) => line && <div key={key}>{line}</div>)}
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
}
