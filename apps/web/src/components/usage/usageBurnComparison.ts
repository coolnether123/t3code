import type { UsageQuotaSample } from "@t3tools/contracts";
import { quotaForecast } from "@t3tools/shared/usageQuotaForecast";
import type { ChartActivity } from "./usageChartActivity";

const HOUR = 3_600_000;
const HORIZON = 6 * HOUR;
const READING_TOLERANCE = 15 * 60_000;

/** Compare projections made at the time, never costs or readings from after the origin. */
export function compareUsageBurn(
  samples: readonly UsageQuotaSample[],
  activity: readonly ChartActivity[],
) {
  const readings = [...samples].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const bins = [...activity]
    .map((row) => ({
      start: Date.parse(row.interval.sinceTime),
      end: Date.parse(row.interval.untilTime),
      cost:
        row.models === null ||
        row.models.some((model) => model.unpricedRecords > 0 || !Number.isFinite(model.costUsd))
          ? null
          : row.models.reduce((total, model) => total + model.costUsd, 0),
    }))
    .sort((a, b) => a.start - b.start);
  const costBetween = (start: number, end: number, knownAt: number) => {
    let covered = start;
    let cost = 0;
    for (const bin of bins) {
      if (bin.end <= covered || bin.start >= end) continue;
      if (bin.end > knownAt || bin.start > covered || bin.cost === null || bin.end <= bin.start)
        return null;
      const until = Math.min(end, bin.end);
      cost += (bin.cost * (until - covered)) / (bin.end - bin.start);
      covered = until;
      if (covered === end) break;
    }
    return covered === end ? cost : null;
  };
  let apiWins = 0;
  let forecastWins = 0;
  let ties = 0;
  let apiError = 0;
  let forecastError = 0;
  let lastOrigin = -Infinity;
  for (let index = 0; index < readings.length; index++) {
    const origin = readings[index]!;
    const at = Date.parse(origin.observedAt);
    if (at - lastOrigin < HORIZON || origin.remainingPercent <= 0) continue;
    if (origin.resetsAt !== readings[0]!.resetsAt) continue;
    const target = readings.find(
      (reading) =>
        Date.parse(reading.observedAt) >= at + HORIZON &&
        Date.parse(reading.observedAt) <= at + HORIZON + READING_TOLERANCE,
    );
    if (
      !target ||
      target.resetsAt !== origin.resetsAt ||
      target.remainingPercent > origin.remainingPercent
    )
      continue;
    const through = readings.slice(index, readings.indexOf(target) + 1);
    if (
      through.some(
        (reading, position) =>
          reading.resetsAt !== origin.resetsAt ||
          (position > 0 &&
            Date.parse(reading.observedAt) - Date.parse(through[position - 1]!.observedAt) >
              2 * HOUR),
      )
    )
      continue;
    const lastComplete = bins.findLast((bin) => bin.end <= at)?.end;
    if (lastComplete === undefined || lastComplete - HORIZON < Date.parse(readings[0]!.observedAt))
      continue;
    const calibration = readings.findLast(
      (reading) => Date.parse(reading.observedAt) <= lastComplete,
    );
    if (!calibration || lastComplete - Date.parse(calibration.observedAt) > READING_TOLERANCE)
      continue;
    const pointsUsed = readings[0]!.remainingPercent - calibration.remainingPercent;
    if (pointsUsed < 5 || calibration.resetsAt !== origin.resetsAt) continue;
    const totalCost = costBetween(
      Date.parse(readings[0]!.observedAt),
      Date.parse(calibration.observedAt),
      at,
    );
    const recentCost = costBetween(lastComplete - HORIZON, lastComplete, at);
    if (totalCost === null || totalCost <= 0 || recentCost === null) continue;
    const forecast = quotaForecast(readings.slice(0, index + 1), at);
    if (!forecast || forecast.stale) continue;
    const actual = origin.remainingPercent - target.remainingPercent;
    const api = Math.min(origin.remainingPercent, (recentCost * pointsUsed) / totalCost);
    const blended = Math.min(
      origin.remainingPercent,
      (forecast.expectedPercentPerDay * HORIZON) / (24 * HOUR),
    );
    const apiMiss = Math.abs(actual - api);
    const forecastMiss = Math.abs(actual - blended);
    if (apiMiss + 0.5 < forecastMiss) apiWins++;
    else if (forecastMiss + 0.5 < apiMiss) forecastWins++;
    else ties++;
    apiError += apiMiss;
    forecastError += forecastMiss;
    lastOrigin = at;
  }
  const checks = apiWins + forecastWins + ties;
  return {
    checks,
    apiWins,
    forecastWins,
    ties,
    apiMeanError: checks ? apiError / checks : null,
    forecastMeanError: checks ? forecastError / checks : null,
  };
}
