/** A wait remains actionable until that failed turn gets a closing activity. */
export function isCapacityRetryWaiting(
  status: string | null | undefined,
  activities: ReadonlyArray<{ readonly kind: string; readonly turnId: string | null }>,
): boolean {
  if (status !== "error") return false;
  const closedTurns = new Set(
    activities
      .filter((activity) => activity.kind === "capacity.retry.finished")
      .map((activity) => activity.turnId),
  );
  return activities.some(
    (activity) => activity.kind === "capacity.retry.waiting" && !closedTurns.has(activity.turnId),
  );
}
