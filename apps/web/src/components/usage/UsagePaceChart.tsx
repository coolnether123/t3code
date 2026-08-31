import type { UsageQuotaSample } from "@t3tools/contracts";
import {
  currentResetAnnouncement,
  type ResetNews,
} from "@t3tools/client-runtime/resetAnnouncements";
import {
  describeRecentQuotaPace,
  quotaDuration,
  quotaForecast,
} from "@t3tools/shared/usageQuotaForecast";
import { useEffect, useMemo, useState, type ReactNode } from "react";

const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
const time = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

export function UsagePaceChart({
  samples,
  news,
  resetCheck,
}: {
  readonly samples: readonly UsageQuotaSample[];
  readonly news?: ResetNews;
  readonly resetCheck?: ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  const [view, setView] = useState<"forecast" | "observed">("forecast");
  const [showRecentPace, setShowRecentPace] = useState(true);
  useEffect(() => setNow(Date.now()), [samples]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const announced = currentResetAnnouncement(news, samples.at(-1), now);
  const forecast = useMemo(
    () => quotaForecast(samples, now, 3, announced?.targetAt),
    [samples, now, announced],
  );
  if (!forecast) return null;
  const f = forecast;
  const observed = view === "observed";
  const y = (percent: number) => 196 - percent * 1.92;
  const pointX = (p: (typeof f.points)[number]) =>
    observed
      ? (Date.parse(p.observedAt) - Date.parse(f.first.observedAt)) /
        Math.max(Date.parse(f.latest.observedAt) - Date.parse(f.first.observedAt), 1)
      : p.x;
  const path = f.points
    .map((p) => `${p.breakBefore ? "M" : "L"}${pointX(p) * 960},${y(p.remainingPercent)}`)
    .join(" ");
  const ending = observed ? f.latest.observedAt : f.planningResetAt;
  const hourly = f.resetInMs < 86_400_000;
  return (
    <section aria-label="Current Codex usage" className="min-w-0">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Current weekly limit</span>
        <span role="status" className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${f.stale ? "bg-amber-500" : "bg-emerald-500"}`}
          />
          {f.stale ? "Reading is stale" : `Updated ${time(f.latest.observedAt)}`}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-6xl font-medium tracking-tight tabular-nums">
            {f.latest.remainingPercent}%
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            remaining{f.stale ? " at last reading" : ""}
          </p>
        </div>
        <div className="pb-1 text-right">
          <p className="text-3xl tabular-nums">{f.usedPercent}%</p>
          <p className="mt-1 text-sm text-muted-foreground">used this cycle</p>
        </div>
      </div>
      <div className="mt-5 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="bg-foreground" style={{ width: `${f.latest.remainingPercent}%` }} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        The monitor captured a {f.monitoredUsedPercent}-point drop since {date(f.first.observedAt)}.
        {f.usedBeforeMonitoring > 0
          ? ` You had already used ${f.usedBeforeMonitoring}% when it started.`
          : " It started at 100%."}
      </p>
      {f.stale ? (
        <p role="alert" className="mt-4 border-l-2 border-amber-500 pl-3 text-sm">
          No fresh reading. Check the background collector. Forecasts below use the last saved
          reading.
        </p>
      ) : null}
      <div className="mt-6 border-y border-border py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-sm font-medium">
            {f.usesAnnouncement ? "Announced reset" : "Weekly reset"}
          </h2>
          <span className="text-lg font-medium tabular-nums">
            {quotaDuration(f.resetInMs)} left
          </span>
        </div>
        <p className="mt-1 text-sm">{date(f.planningResetAt)}</p>
        {announced ? (
          <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {f.usesAnnouncement
              ? "Planning uses the earlier announced time. "
              : "Announced time passed. Waiting for an account reading to confirm a reset. "}
            <a
              className="underline underline-offset-4"
              href={announced.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Tibo's post
            </a>
            {" via "}
            <a
              className="underline underline-offset-4"
              href="https://resetbeacon.com/"
              target="_blank"
              rel="noreferrer"
            >
              Reset Beacon
            </a>
            .
            <details className="mt-1">
              <summary className="min-h-11 cursor-pointer content-center">
                Source and weekly timer
              </summary>
              <p className="pb-2">
                {announced.quote} The feed interprets Pacific local time. Announcement timing is not
                account confirmation.
              </p>
              <p>Account weekly timer: {date(f.latest.resetsAt)}.</p>
            </details>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {news?.status === "loading"
              ? "Checking reset announcements…"
              : news?.status === "unavailable"
                ? "Reset news unavailable. Using your account's weekly timer."
                : "No earlier reset announcement available."}
          </p>
        )}
      </div>
      {resetCheck}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Usage over time</h2>
        <div className="flex rounded-lg bg-muted p-1" role="group" aria-label="Chart view">
          {(
            [
              ["observed", "Recorded"],
              ["forecast", "To reset"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
              className={`min-h-11 rounded-md px-3 text-xs focus-visible:outline-2 focus-visible:outline-ring ${view === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-5 flex gap-2">
        <div aria-hidden className="relative h-48 w-9 shrink-0 text-xs text-muted-foreground">
          {[100, 50, 0].map((p) => (
            <span
              key={p}
              className="absolute right-0 -translate-y-1/2"
              style={{ top: `${2 + (100 - p) * 0.96}%` }}
            >
              {p}%
            </span>
          ))}
        </div>
        <div className="relative h-48 min-w-0 flex-1">
          <svg
            viewBox="0 0 960 200"
            preserveAspectRatio="none"
            className="h-full w-full overflow-visible"
            role="img"
            aria-label={
              observed
                ? "Recorded Codex remaining usage"
                : "Codex remaining usage and pace to next reset"
            }
          >
            <desc>
              Solid: saved readings. Dashed: target pace. Orange: blended projection.
              {showRecentPace && f.recentPace && !observed ? " Cyan: recent pace projection." : ""}
              {" Gaps are not joined."}
            </desc>
            {[4, 100, 196].map((lineY) => (
              <line
                key={lineY}
                x1={0}
                x2={960}
                y1={lineY}
                y2={lineY}
                stroke="currentColor"
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {!observed ? (
              <>
                <line
                  x1={f.observationX * 960}
                  y1={y(f.latest.remainingPercent)}
                  x2={960}
                  y2={y(f.reserve)}
                  stroke="currentColor"
                  className="text-muted-foreground"
                  strokeDasharray="4 5"
                  vectorEffect="non-scaling-stroke"
                />
                {showRecentPace && f.recentPace ? (
                  <path
                    aria-label="Recent pace projection"
                    d={`M${f.observationX * 960},${y(f.latest.remainingPercent)} L${f.recentPace.projectionEndX * 960},${y(f.recentPace.projectionEndPercent)} L960,${y(f.recentPace.projectionEndPercent)}`}
                    fill="none"
                    stroke="#52b8bf"
                    strokeWidth={2}
                    strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
                <line
                  x1={f.observationX * 960}
                  y1={y(f.latest.remainingPercent)}
                  x2={f.projectionEndX * 960}
                  y2={y(f.projectionEndPercent)}
                  stroke="#d88d42"
                  strokeWidth={2}
                  strokeDasharray="7 4"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            ) : null}
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span
            aria-hidden
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
            style={{
              left: `${observed ? (f.points.length > 1 ? 100 : 0) : f.observationX * 100}%`,
              top: `${2 + (100 - f.latest.remainingPercent) * 0.96}%`,
            }}
          />
        </div>
      </div>
      <div className="ml-11 mt-2 flex justify-between gap-3 text-xs text-muted-foreground">
        <span>{time(f.first.observedAt)}</span>
        <span className="text-right">{observed ? time(ending) : date(ending)}</span>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        <span>━━ Recorded</span>
        {!observed ? (
          <>
            <span className="text-muted-foreground">┄┄ Target</span>
            <span style={{ color: "#d88d42" }}>┄┄ Blended pace</span>
          </>
        ) : null}
      </div>
      {!observed ? (
        <div className="mt-2">
          <label className="flex min-h-11 w-fit cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              aria-label="Show recent pace"
              className="size-4 accent-[#52b8bf]"
              checked={showRecentPace}
              onChange={(event) => setShowRecentPace(event.target.checked)}
            />
            <span style={{ color: "#52b8bf" }}>┄ Recent pace</span>
          </label>
          {showRecentPace ? (
            <p role="status" className="text-xs leading-relaxed text-muted-foreground">
              {describeRecentQuotaPace(f)}
            </p>
          ) : null}
        </div>
      ) : null}
      <dl className="mt-6 grid grid-cols-2 gap-x-5 gap-y-5 border-t border-border pt-5 [&>div]:min-w-0">
        <div>
          <dt className="text-xs text-muted-foreground">
            {f.stale ? "Last run-out estimate" : "At this pace"}
          </dt>
          <dd className="mt-1 text-lg font-medium tabular-nums">
            {f.exhaustsBeforeReset
              ? f.exhaustionInMs === null
                ? "No burn recorded"
                : `${quotaDuration(f.exhaustionInMs)} to empty`
              : `${f.remainingAtReset.toFixed(0)}% left at reset`}
          </dd>
          <dd className="mt-1 text-xs text-muted-foreground">
            {f.exhaustsBeforeReset ? "Runs out before reset" : "Reset comes first"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Pace to reset</dt>
          <dd className="mt-1 text-lg font-medium tabular-nums">
            {(hourly ? f.recommendedPercentPerDay / 24 : f.recommendedPercentPerDay).toFixed(1)}% /{" "}
            {hourly ? "hour" : "day"}
          </dd>
          <dd className="mt-1 text-xs text-muted-foreground">To leave {f.reserve}% unused</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Blended burn</dt>
          <dd className="mt-1 tabular-nums">{(f.expectedPercentPerDay / 24).toFixed(2)}% / hour</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Projected Exhaustion</dt>
          <dd className="mt-1 text-sm">
            {f.exhaustionAt ? date(f.exhaustionAt) : "No burn recorded"}
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Orange blends monitored usage with the weekly average. Recent pace uses only the latest 30
        minutes. Both assume their pace continues. Percentages are rounded, so actual remaining
        usage may be lower.
      </p>
    </section>
  );
}
