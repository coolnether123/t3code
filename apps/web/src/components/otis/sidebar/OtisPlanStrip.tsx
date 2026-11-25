import type { EnvironmentId } from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import {
  PLANS,
  planOutlook,
  planQuotaTime,
  planRunOutTime,
  planSamples,
  type PlanOutlook,
} from "@t3tools/shared/usagePlanOutlook";
import { useGT } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useUsage } from "~/state/usage";
import { useVisiblePlanClock } from "../../usage/PlanOutlook";

function PlanPhrase({ outlook, now }: { readonly outlook: PlanOutlook; readonly now: number }) {
  const gt = useGT();
  switch (outlook.status) {
    case "leftover":
      return (
        <>
          {gt("~{unused}% unused", { unused: Math.floor(outlook.unused) })}
          <span className="hidden @min-[300px]/plan-strip:inline">
            {" "}
            · {gt("resets {time}", { time: planQuotaTime(outlook.reset, now) })}
          </span>
        </>
      );
    case "runsOut":
      return gt("out ~{time}", { time: planRunOutTime(outlook.runsOutAt, now) });
    case "exhausted":
      return gt("out until {time}", { time: planQuotaTime(outlook.reset, now) });
    case "stale":
      return gt("last read {time}", { time: planQuotaTime(outlook.observed, now) });
    case "noPace":
      return gt("resets {time}", { time: planQuotaTime(outlook.reset, now) });
    case "missing":
      return gt("no readings");
    case "loading":
      return gt("Reading limits…");
  }
}

export function OtisPlanStrip({
  environmentId,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const { visible, now } = useVisiblePlanClock();
  const [input] = useState(() => ({ ...makeWindow(1), quotaHistoryOnly: true }));
  const history = useUsage(input, new Set([environmentId]));
  const refresh = useEffectEvent(() => void history.refresh({ ...input, refresh: false }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh only when the user can see the strip.
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [visible]);
  const summary =
    history.environments.find((environment) => environment.environmentId === environmentId)
      ?.summary ?? null;
  return (
    <section
      className="@container/plan-strip mb-1 border-b border-border pb-1"
      aria-label={gt("Plans")}
    >
      <h2 className="px-2.5 text-2xs text-muted-foreground">{gt("Plans")}</h2>
      {PLANS.map((plan) => {
        const outlook = planOutlook(planSamples(summary, plan), now, plan.id);
        if (
          outlook.status === "missing" &&
          plan.id === "gemini" &&
          !summary?.providerQuotaHistories?.some((window) => window.provider === "antigravity")
        )
          return null;
        const remaining = "remaining" in outlook ? Math.round(outlook.remaining) : null;
        const label =
          remaining !== null && "reset" in outlook
            ? gt("{plan}: {remaining}% of the week left, resets {time}.", {
                plan: plan.short,
                remaining,
                time: planQuotaTime(outlook.reset, now),
              })
            : plan.short;
        const prediction =
          outlook.status === "leftover"
            ? gt("Prediction: about {unused}% unused at reset.", {
                unused: Math.floor(outlook.unused),
              })
            : outlook.status === "runsOut"
              ? gt("Predicted to run out about {time}.", {
                  time: planRunOutTime(outlook.runsOutAt, now),
                })
              : "";
        return (
          <button
            key={plan.id}
            type="button"
            data-fleet-link=""
            aria-label={`${label} ${prediction}`.trim()}
            onClick={onOpen}
          >
            <span className="w-12 shrink-0 text-xs">{plan.short}</span>
            {remaining !== null && (
              <span className="shrink-0 text-xs tabular-nums">{remaining}% ·</span>
            )}
            <span
              className={
                outlook.status === "leftover"
                  ? "truncate text-xs text-foreground"
                  : "truncate text-xs text-muted-foreground"
              }
            >
              <PlanPhrase outlook={outlook} now={now} />
            </span>
            {outlook.status === "runsOut" && (
              <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warning" />
            )}
            {outlook.status === "exhausted" && (
              <span className="ml-auto size-1.5 shrink-0 rounded-full bg-destructive" />
            )}
          </button>
        );
      })}
    </section>
  );
}
