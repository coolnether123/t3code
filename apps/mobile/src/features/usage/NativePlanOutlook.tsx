import type { UsageSummary } from "@t3tools/contracts";
import {
  PLANS,
  moveWorkCallout,
  planOutlook,
  planQuotaTime,
  planRunOutTime,
  planSamples,
} from "@t3tools/shared/usagePlanOutlook";
import { quotaDuration } from "@t3tools/shared/usageQuotaForecast";
import { useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

export function NativePlanOutlook({ summary }: { readonly summary: UsageSummary | null }) {
  const gt = useGT();
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh the visible quota countdown while the card is mounted.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const time = (value: number) => planQuotaTime(value, now);
  const plans = PLANS.map((plan) => ({
    plan,
    outlook: planOutlook(planSamples(summary, plan), now, plan.id),
  }));
  const callout = moveWorkCallout(plans);
  return (
    <View className="gap-3">
      <Text className="text-sm font-medium text-foreground">{gt("Plans")}</Text>
      {callout && (
        <Text className="rounded-lg border border-border p-3 text-sm text-foreground">
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
                  time: time(callout.spare.outlook.reset),
                },
              )
            : gt("No plan has spare room this week.")}
        </Text>
      )}
      {plans.map(({ plan, outlook }) => {
        const projection =
          outlook.status === "runsOut" || outlook.status === "leftover" ? outlook : null;
        const reset = "reset" in outlook ? outlook.reset : null;
        const used = "remaining" in outlook ? 100 - outlook.remaining : null;
        const forecastUse =
          outlook.status === "runsOut"
            ? outlook.remaining
            : outlook.status === "leftover"
              ? outlook.remaining - outlook.unused
              : 0;
        return (
          <View key={plan.id} className="gap-2 rounded-lg border border-border p-4">
            <Text className="text-sm font-medium text-foreground">
              {plan.short}
              <Text className="text-foreground-muted"> · {plan.plan}</Text>
            </Text>
            {"remaining" in outlook && (
              <Text className="text-2xl font-semibold tabular-nums text-foreground">
                {gt("{percent}% left", {
                  percent:
                    plan.id === "gemini"
                      ? Number(outlook.remaining.toFixed(1))
                      : Math.round(outlook.remaining),
                })}{" "}
                <Text className="text-xs text-foreground-muted">{gt("of the week")}</Text>
              </Text>
            )}
            {reset !== null && (
              <Text className="text-xs text-foreground-muted">
                {reset > now
                  ? gt("Resets {time} · in {countdown}", {
                      time: time(reset),
                      countdown: quotaDuration(reset - now),
                    })
                  : gt("Reset was due {time}", { time: time(reset) })}
              </Text>
            )}
            {used !== null && (
              <View className="h-1.5 flex-row overflow-hidden rounded-full bg-foreground/20">
                <View className="bg-foreground/80" style={{ width: `${used}%` }} />
                <View
                  className={outlook.status === "runsOut" ? "bg-warning" : "bg-foreground/30"}
                  style={{ width: `${forecastUse}%` }}
                />
              </View>
            )}
            {projection && (
              <Text className="text-sm text-foreground">
                {gt("Buys about {hours} hours of work.", {
                  hours: Math.round(projection.hoursLeft),
                })}
              </Text>
            )}
            <Text
              className={
                outlook.status === "runsOut" ? "text-sm text-warning" : "text-sm text-foreground"
              }
            >
              {outlook.status === "runsOut"
                ? gt("Runs out about {time}, {gap} before reset.", {
                    time: planRunOutTime(outlook.runsOutAt, now),
                    gap: quotaDuration(outlook.gap),
                  })
                : outlook.status === "leftover"
                  ? gt("About {unused}% will be unused at reset.", {
                      unused: Math.floor(outlook.unused),
                    })
                  : outlook.status === "exhausted"
                    ? gt("Out until {time}.", { time: time(outlook.reset) })
                    : outlook.status === "stale"
                      ? gt("Last reading {time}. Prediction paused until a new reading arrives.", {
                          time: time(outlook.observed),
                        })
                      : outlook.status === "noPace"
                        ? gt("Not enough use since {time} to predict.", {
                            time: time(outlook.firstObserved),
                          })
                        : outlook.status === "missing"
                          ? gt("No readings for the {plan} weekly limit yet.", { plan: plan.short })
                          : gt("Reading limits…")}
            </Text>
            {projection && (
              <Text className="text-xs text-foreground-muted">
                {projection.sinceReset === null
                  ? gt("Prediction at the last 24 hours’ pace ({pace}% a day).", {
                      pace: Math.round(projection.perDay),
                    })
                  : gt("Prediction at the pace since the reset {time} ({pace}% a day).", {
                      time: time(projection.sinceReset),
                      pace: Math.round(projection.perDay),
                    })}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
