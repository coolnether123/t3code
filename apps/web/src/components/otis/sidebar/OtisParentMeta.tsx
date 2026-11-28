import type { OtisNode } from "@t3tools/contracts";
import type { fleetRowLabels } from "@t3tools/client-runtime/otis/tree";
import { useGT, useLocale } from "gt-react";
import { Info } from "lucide-react";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../ui/popover";

function useParentFields(node: OtisNode, model: string) {
  const gt = useGT();
  const locale = useLocale();
  const hasModel = node.modelEvidence !== null || node.model !== "No model assigned";
  const amount =
    node.costSource === "api-equivalent-t3" && node.costUsd !== null
      ? new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(node.costUsd)
      : null;
  return {
    model: hasModel ? model : gt("No model assigned"),
    cost: amount === null ? gt("Cost unknown") : gt("{cost} today", { cost: amount }),
    amount,
  };
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
  const fields = useParentFields(node, model);
  return (
    <>
      <span className="flex items-baseline gap-x-1 text-xs text-muted-foreground max-md:pe-7">
        <span className="min-w-0 shrink truncate">{fields.model}</span>
        <span className="whitespace-nowrap tabular-nums">
          <span aria-hidden="true" className="me-1">
            ·
          </span>
          {fields.cost}
        </span>
        <span className="whitespace-nowrap tabular-nums">
          <span aria-hidden="true" className="me-1">
            ·
          </span>
          <span aria-hidden="true">{gt("{count} running", { count: node.sub.running })}</span>
          <span className="sr-only">
            {gt("Running workers: {count}", { count: node.sub.running })}
          </span>
        </span>
      </span>
      {node.sub.failedUnseen > 0 && (
        <span className="inline-block whitespace-nowrap rounded-full bg-destructive/10 px-1.5 text-xs font-semibold text-destructive tabular-nums">
          {gt("{count} failed", { count: node.sub.failedUnseen })}
        </span>
      )}
    </>
  );
}

export function OtisParentDetails({
  node,
  labels,
  title,
}: {
  node: OtisNode;
  labels: ReturnType<typeof fleetRowLabels>;
  title: string;
}) {
  const gt = useGT();
  const locale = useLocale();
  const fields = useParentFields(node, labels.model);
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        data-fleet-action=""
        aria-label={gt("Details for {title}", { title })}
        className="grid min-h-8 w-6 shrink-0 place-items-center"
      >
        <Info aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup side="right" align="start" width="sm" padding="compact">
        <PopoverTitle>
          <span className="wrap-anywhere">{title}</span>
        </PopoverTitle>
        <div className="mt-1 space-y-1 text-xs wrap-anywhere text-muted-foreground">
          <div>
            {fields.model} · {labels.state || gt("Idle")}
          </div>
          <div>
            {fields.amount === null
              ? fields.cost
              : gt("API-equivalent cost today: {cost}", { cost: fields.amount })}
          </div>
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
          {node.sub.failed !== undefined && (
            <div>{gt("{count} failed since the parent started", { count: node.sub.failed })}</div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
