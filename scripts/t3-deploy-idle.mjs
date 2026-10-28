export function idleEvidence(pages, router) {
  if (!pages.length) return { idle: false, reason: "no-snapshot" };
  const first = pages[0];
  const sameRuntime = (a, b) => a?.pid === b?.pid && a?.startedAt === b?.startedAt;
  if (
    !first.runtime?.pid ||
    !first.runtime.startedAt ||
    pages.some(
      (p) =>
        !sameRuntime(p.runtime, first.runtime) || p.snapshotSequence !== first.snapshotSequence,
    )
  )
    return { idle: false, reason: "runtime-or-state-changed" };
  const threads = pages.flatMap((p) => p.threads);
  if (
    threads.length !== first.threadCount ||
    new Set(threads.map((t) => t.id)).size !== first.threadCount
  )
    return { idle: false, reason: "incomplete-thread-coverage" };
  if (
    threads.some(
      (t) =>
        t.activeRunId ||
        !["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
          t.status,
        ),
    )
  )
    return { idle: false, reason: "active-thread" };
  if (first.voice !== undefined) {
    return {
      idle: pages.every(
        (p) =>
          p.voice?.coverage === "complete" &&
          p.voice.count === 0 &&
          p.voice.openCalls.length === 0 &&
          Array.isArray(p.voice.activeSessions) &&
          p.voice.activeSessions.length === 0 &&
          sameRuntime(p.voice.runtime, first.runtime),
      ),
      fallback: false,
      runtime: first.runtime,
    };
  }
  const tenants = router?.speech?.tenants;
  const stopped = (name) =>
    Array.isArray(tenants) && tenants.some((t) => t.id === name && t.running === false);
  return {
    idle:
      router?.speech?.voiceSessions === 0 &&
      stopped("whisper-large-v3-turbo") &&
      stopped("breeze-tts-2"),
    fallback: true,
    runtime: first.runtime,
  };
}
