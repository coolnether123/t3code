import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProviderUsageLimits, UsageSummary } from "@t3tools/contracts";
import { UsageDay } from "@t3tools/contracts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { isModelCostUnknown } from "@t3tools/shared/usageMerge";
import {
  moveWorkCallout,
  parentShares,
  PLANS,
  planForProvider,
  planOutlook,
  planQuotaTime,
  planRunOutTime,
  planSamples,
  planUsageDays,
  type PlanOutlook as Outlook,
} from "@t3tools/shared/usagePlanOutlook";
import { quotaDuration } from "@t3tools/shared/usageQuotaForecast";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { environmentPresentations } from "~/state/presentation";
import { useUsage } from "~/state/usage";
import { otisLaneUsage, useFleet } from "../otis/sidebar/fleetData";
import { UsageBar } from "../chat/ThreadDetailsUsage";
import { limitWindows } from "./usageLimitWindows";

type Plan = (typeof PLANS)[number];

export function useVisiblePlanClock() {
  const { visible } = useSyncExternalStore(
    subscribeDocumentActivity,
    getDocumentActivity,
    getDocumentActivity,
  );
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep visible countdowns current without waking hidden pages.
  useEffect(() => {
    if (!visible) return;
    const next = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.clearTimeout(next);
      window.clearInterval(timer);
    };
  }, [visible]);
  return { visible, now };
}

function Possibility({
  plan,
  outlook,
  now,
  hasCredits,
}: {
  readonly plan: Plan;
  readonly outlook: Outlook;
  readonly now: number;
  readonly hasCredits: boolean;
}) {
  const gt = useGT();
  const time = (value: number) => planQuotaTime(value, now);
  switch (outlook.status) {
    case "loading":
      return <p>{gt("Reading limits…")}</p>;
    case "missing":
      return (
        <>
          <p>{gt("No readings for the {plan} weekly limit yet.", { plan: plan.short })}</p>
          <p className="text-xs text-muted-foreground">
            {plan.id === "claude"
              ? gt(
                  "T3 reads Claude limits through the Claude CLI. If the CLI is signed out, run claude auth login in a terminal.",
                )
              : plan.id === "codex"
                ? gt("Codex readings come from the Codex Limits tracker running on this computer.")
                : gt(
                    "T3 reads Gemini limits from Antigravity on this computer. Open Antigravity once and sign in.",
                  )}
          </p>
        </>
      );
    case "stale":
      return (
        <p className="text-muted-foreground">
          {gt("Last reading {time}. Prediction paused until a new reading arrives.", {
            time: time(outlook.observed),
          })}
        </p>
      );
    case "noPace":
      return (
        <p>
          {gt("Not enough use since {time} to predict.", { time: time(outlook.firstObserved) })}
        </p>
      );
    case "exhausted":
      return (
        <>
          <p className="text-error-foreground">
            {gt("Out until {time}.", { time: time(outlook.reset) })}
          </p>
          {hasCredits && <p>{gt("A banked reset would restart the week now.")}</p>}
        </>
      );
    case "runsOut":
    case "leftover":
      return (
        <>
          <p>{gt("Buys about {hours} hours of work.", { hours: Math.round(outlook.hoursLeft) })}</p>
          {outlook.status === "runsOut" ? (
            <>
              <p className="text-warning-foreground">
                {gt("Runs out about {time}, {gap} before reset.", {
                  time: planRunOutTime(outlook.runsOutAt, now),
                  gap: quotaDuration(outlook.gap),
                })}
              </p>
              <p>
                {gt("To last: about {rate}% a day, about {percent}% of today’s pace.", {
                  rate: Math.round(outlook.paceToLast),
                  percent: Math.round(outlook.multiple * 100),
                })}
              </p>
            </>
          ) : (
            <>
              <p>
                {gt("About {unused}% will be unused at reset.", {
                  unused: Math.floor(outlook.unused),
                })}
              </p>
              <p>
                {outlook.multiple >= 1.2
                  ? gt("Room for about {multiple}× today’s work.", {
                      multiple: outlook.multiple.toFixed(1),
                    })
                  : gt("On track to use it all.")}
              </p>
            </>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {outlook.sinceReset === null
              ? gt("Prediction at the last 24 hours’ pace ({pace}% a day).", {
                  pace: Math.round(outlook.perDay),
                })
              : gt("Prediction at the pace since the reset {time} ({pace}% a day).", {
                  time: time(outlook.sinceReset),
                  pace: Math.round(outlook.perDay),
                })}
          </p>
        </>
      );
  }
}

function UsageSinceYesterday({
  plan,
  outlook,
  environmentId,
  now,
}: {
  readonly plan: Plan;
  readonly outlook: Outlook;
  readonly environmentId: EnvironmentId;
  readonly now: number;
}) {
  const gt = useGT();
  const { sinceDay, untilDay, timeZone } = planUsageDays(now);
  const input = {
    sinceDay: UsageDay.make(sinceDay),
    untilDay: UsageDay.make(untilDay),
    timeZone,
    resolution: "day" as const,
  };
  const usage = useUsage(input, new Set([environmentId]));
  const refresh = useEffectEvent(() => void usage.refresh({ ...input, refresh: false }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh the cost scan on a timer while this card is visible.
  useEffect(() => {
    if (plan.id !== "claude") return;
    const timer = window.setInterval(refresh, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [plan.id]);
  const laneUsage = useAtomValue(
    otisLaneUsage({ environmentId, input: { since: sinceDay, until: untilDay } }),
  );
  const { nodes } = useFleet();
  const namedLanes = new Map(
    [...nodes.values()].flatMap((node) =>
      node.kind === "lane" ? [[node.id, node.title] as const] : [],
    ),
  );
  const models = usage.merged.models.filter(
    (model) => planForProvider(model.provider)?.id === plan.id && !isModelCostUnknown(model),
  );
  const total = models.reduce((sum, model) => sum + model.costUsd, 0);
  const shares = AsyncResult.isSuccess(laneUsage)
    ? parentShares(laneUsage.value.rows, plan, total, namedLanes)
    : null;
  const [first, second] = shares?.parents ?? [];
  const pairShare = first && second ? first.share + second.share : 0;
  const currency = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  return (
    <div className="mt-3 space-y-1 border-t pt-2 text-xs">
      <h4 className="font-medium">{gt("Used since yesterday")}</h4>
      {shares && (
        <>
          <p className="tabular-nums">
            {[
              ...shares.parents.map(({ name, share }) =>
                gt("{name} {share}%", { name, share: Math.round(share * 100) }),
              ),
              shares.partial
                ? gt("other {share}% (partial)", { share: Math.round(shares.other * 100) })
                : gt("other {share}%", { share: Math.round(shares.other * 100) }),
            ].join(" · ")}
          </p>
          <p className="text-muted-foreground">
            {gt("Shares by API-equivalent cost since yesterday.")}
          </p>
        </>
      )}
      {(plan.id !== "claude" || !shares) && models.length > 0 && (
        <p>
          {models.map((model) => `${model.model} ${currency.format(model.costUsd)}`).join(" · ")}
        </p>
      )}
      {!shares && models.length === 0 && (
        <p className="text-muted-foreground">
          {usage.isPending ? gt("Reading usage…") : gt("No priced usage available.")}
        </p>
      )}
      {plan.id === "claude" &&
        first &&
        second &&
        pairShare >= (shares?.other ?? 0) &&
        (outlook.status === "leftover" || outlook.status === "runsOut") && (
          <p>
            {outlook.status === "leftover"
              ? gt("{first} + {second}: about {rate}% a day, covered until reset.", {
                  first: first.name,
                  second: second.name,
                  rate: (pairShare * outlook.perDay).toFixed(1),
                })
              : gt("{first} + {second}: about {rate}% a day, about {hours} more hours.", {
                  first: first.name,
                  second: second.name,
                  rate: (pairShare * outlook.perDay).toFixed(1),
                  hours: Math.round(outlook.hoursLeft),
                })}
          </p>
        )}
    </div>
  );
}

function PlanCard({
  plan,
  outlook,
  summary,
  live,
  now,
  environmentId,
}: {
  readonly plan: Plan;
  readonly outlook: Outlook;
  readonly summary: UsageSummary | null;
  readonly live: ServerProviderUsageLimits | undefined;
  readonly now: number;
  readonly environmentId: EnvironmentId | undefined;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const credits = plan.id === "codex" ? live?.resetCredits : undefined;
  const hasCredits = !!credits?.availableCount;
  const otherWindows = limitWindows(summary).flatMap((window) => {
    if (window.key === plan.weekly || planForProvider(window.provider)?.id !== plan.id) return [];
    const latest = window.samples.at(-1);
    return latest && now - Date.parse(latest.observedAt) <= 2 * window.windowMs
      ? [
          {
            id: window.key,
            label: window.label,
            reading: planOutlook(window.samples, now, plan.id),
          },
        ]
      : [];
  });
  const codexSession =
    plan.id === "codex"
      ? live?.windows.find((window) => window.id === "primary" || window.kind === "session")
      : undefined;
  const remaining = "remaining" in outlook ? outlook.remaining : null;
  const used = remaining === null ? null : 100 - remaining;
  const predicted =
    outlook.status === "leftover"
      ? outlook.remaining - outlook.unused
      : outlook.status === "runsOut"
        ? outlook.remaining
        : 0;
  return (
    <article className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm">
      <h3 className="font-medium">
        {plan.short}
        <span className="font-normal text-muted-foreground"> · {plan.plan}</span>
      </h3>
      {remaining !== null && "reset" in outlook && (
        <>
          <p>
            <span className="text-2xl font-semibold tabular-nums">
              {gt("{percent}% left", {
                percent:
                  plan.id === "gemini" ? Number(remaining.toFixed(1)) : Math.round(remaining),
              })}
            </span>{" "}
            <span className="text-xs text-muted-foreground">{gt("of the week")}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {outlook.reset > now
              ? gt("Resets {time} · in {countdown}", {
                  time: planQuotaTime(outlook.reset, now),
                  countdown: quotaDuration(outlook.reset - now),
                })
              : gt("Reset was due {time}", { time: planQuotaTime(outlook.reset, now) })}
          </p>
        </>
      )}
      {used !== null && (
        <UsageBar
          fill={used}
          predicted={predicted}
          tick={used}
          className="block h-1.5"
          tone={outlook.status === "runsOut" ? "warning" : null}
        />
      )}
      <Possibility plan={plan} outlook={outlook} now={now} hasCredits={hasCredits} />
      <button
        type="button"
        aria-expanded={expanded}
        className="rounded px-1 py-1 text-xs underline @min-[620px]/plans:hidden"
        onClick={() => setExpanded(!expanded)}
      >
        {gt("Details")}
      </button>
      <div className={expanded ? "block" : "hidden @min-[620px]/plans:block"}>
        {(otherWindows.length > 0 || codexSession) && (
          <div className="mt-3 space-y-1 border-t pt-2 text-xs">
            <h4 className="font-medium">{gt("Other limits")}</h4>
            {otherWindows.map(
              ({ id, label, reading }) =>
                "remaining" in reading && (
                  <p key={id} className="tabular-nums">
                    {gt("{label}: {remaining}% left", {
                      label,
                      remaining: Math.round(reading.remaining),
                    })}{" "}
                    ·{" "}
                    {reading.status === "leftover"
                      ? gt("about {unused}% unused", { unused: Math.floor(reading.unused) })
                      : gt("resets {time}", { time: planQuotaTime(reading.reset, now) })}
                  </p>
                ),
            )}
            {codexSession && (
              <p>
                {gt("{label}: {remaining}% left", {
                  label: codexSession.label,
                  remaining: Math.round(remainingPercent(codexSession)),
                })}
                {codexSession.resetsAt &&
                  ` · ${gt("resets {time}", { time: planQuotaTime(Date.parse(codexSession.resetsAt), now) })}`}
              </p>
            )}
          </div>
        )}
        {credits && hasCredits && (
          <div className="mt-3 space-y-1 border-t pt-2 text-xs">
            <h4 className="font-medium">{gt("Banked resets")}</h4>
            <p className="tabular-nums">
              {credits.availableCount}
              {credits.nextExpiresAt &&
                ` · ${gt("first expires {time}", { time: planQuotaTime(Date.parse(credits.nextExpiresAt), now) })}`}
            </p>
          </div>
        )}
        {environmentId && (
          <UsageSinceYesterday
            plan={plan}
            outlook={outlook}
            environmentId={environmentId}
            now={now}
          />
        )}
      </div>
    </article>
  );
}

export function PlanOutlook({
  summary,
  environmentId,
}: {
  readonly summary: UsageSummary | null;
  readonly environmentId: EnvironmentId | undefined;
}) {
  const gt = useGT();
  const panel = useRef<HTMLElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const { visible, now } = useVisiblePlanClock();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to intersection events to keep expensive queries offscreen.
  useEffect(() => {
    if (!panel.current) return;
    const observer = new IntersectionObserver(([entry]) =>
      setOnScreen(entry?.isIntersecting ?? false),
    );
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, []);
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const live = environmentId
    ? presentations
        .get(environmentId)
        ?.serverConfig?.providers.find((provider) => provider.driver === "codex")?.usageLimits
    : undefined;
  const plans = PLANS.map((plan) => ({
    plan,
    outlook: planOutlook(planSamples(summary, plan), now, plan.id),
  }));
  const lastReading = Math.max(
    0,
    ...plans.map(({ outlook }) => ("observed" in outlook ? outlook.observed : 0)),
  );
  const callout = moveWorkCallout(plans);
  return (
    <section
      id="plans"
      ref={panel}
      className="@container/plans scroll-mt-3 space-y-3"
      aria-labelledby="plans-title"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="plans-title" className="text-sm font-medium">
          {gt("Plans")}
        </h2>
        {lastReading > 0 && (
          <p className="text-xs text-muted-foreground">
            {gt("Read {time} · refreshes every 5 min", { time: planQuotaTime(lastReading, now) })}
          </p>
        )}
      </header>
      {callout && (
        <p className="rounded-lg border border-border px-3 py-2 text-sm">
          {gt("{plan} runs out about {time}, {gap} before its reset.", {
            plan: callout.short.plan.short,
            time: planRunOutTime(callout.short.outlook.runsOutAt, now),
            gap: quotaDuration(callout.short.outlook.gap),
          })}{" "}
          {callout.spare
            ? gt(
                "{to} will leave about {unused}% unused when it resets {time}. Move {from} work to {to} until then.",
                {
                  from: callout.short.plan.short,
                  to: callout.spare.plan.short,
                  unused: Math.floor(callout.spare.outlook.unused),
                  time: planQuotaTime(callout.spare.outlook.reset, now),
                },
              )
            : gt("No plan has spare room this week.")}
        </p>
      )}
      <div className="grid gap-3 @min-[620px]/plans:[grid-template-columns:repeat(auto-fit,minmax(18rem,1fr))]">
        {plans.map(({ plan, outlook }) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            outlook={outlook}
            summary={summary}
            live={live}
            now={now}
            environmentId={onScreen && visible ? environmentId : undefined}
          />
        ))}
      </div>
    </section>
  );
}
