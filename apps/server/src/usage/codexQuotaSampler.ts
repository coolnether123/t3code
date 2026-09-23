// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This standalone host-side collector writes a JSON history file consumed by the server.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

const WEEK_MINUTES = 7 * 24 * 60;
const MAX_SAMPLES = 5_000;
const ARCHIVE_SAMPLES = 1_000;

export interface CodexQuotaSample {
  readonly observedAt: string;
  readonly remainingPercent: number;
  readonly resetsAt: string;
}

interface RateLimitWindow {
  readonly usedPercent?: unknown;
  readonly resetsAt?: unknown;
  readonly windowDurationMins?: unknown;
}

interface RateLimitSnapshot {
  readonly limitId?: unknown;
  readonly primary?: RateLimitWindow | null;
  readonly secondary?: RateLimitWindow | null;
}

export interface CodexRateLimitsResponse {
  readonly rateLimits?: RateLimitSnapshot | null;
  readonly rateLimitsByLimitId?: Readonly<Record<string, RateLimitSnapshot>> | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validIso(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Selects only Codex's weekly window. It never infers a full balance from startup. */
export function codexWeeklyQuotaSample(
  response: CodexRateLimitsResponse,
  observedAt: string,
): CodexQuotaSample | null {
  const observedAtMs = validIso(observedAt);
  if (observedAtMs === null) return null;
  const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  if (!snapshot || (snapshot.limitId != null && snapshot.limitId !== "codex")) return null;

  const window = [snapshot.primary, snapshot.secondary].find(
    (candidate) => candidate?.windowDurationMins === WEEK_MINUTES,
  );
  if (!window) return null;
  const usedPercent = window.usedPercent;
  const resetSeconds = window.resetsAt;
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    typeof resetSeconds !== "number" ||
    !Number.isFinite(resetSeconds) ||
    resetSeconds <= 0
  )
    return null;
  const resetMs = resetSeconds * 1_000;
  if (resetMs < observedAtMs) return null;
  return {
    observedAt: new Date(observedAtMs).toISOString(),
    remainingPercent: 100 - usedPercent,
    resetsAt: new Date(resetMs).toISOString(),
  };
}

function decodePrior(text: string): {
  root: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  rows: Record<string, unknown>[];
  samples: CodexQuotaSample[];
} {
  const root = object(JSON.parse(text));
  const snapshot = object(root?.Snapshot);
  const mainLimit = object(snapshot?.MainLimit);
  const window = object(mainLimit?.Window);
  if (mainLimit?.LimitId !== "codex" || window?.DurationMinutes !== WEEK_MINUTES) {
    throw new Error("Existing quota history is not a compatible Codex weekly history.");
  }
  if (!Array.isArray(root?.Samples) || root.Samples.length > MAX_SAMPLES) {
    throw new Error("Existing quota history has an invalid sample list.");
  }

  const samples: CodexQuotaSample[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const value of root.Samples) {
    const item = object(value);
    if (!item) throw new Error("Existing quota history contains an invalid sample.");
    const observed = item.ObservedAt;
    const remaining = item.RemainingPercent;
    const resets = item.ResetsAt;
    if (
      typeof observed !== "string" ||
      validIso(observed) === null ||
      typeof remaining !== "number" ||
      !Number.isFinite(remaining) ||
      remaining < 0 ||
      remaining > 100 ||
      typeof resets !== "string" ||
      validIso(resets) === null ||
      Date.parse(observed) > Date.parse(resets)
    ) {
      throw new Error("Existing quota history contains an invalid sample.");
    }
    samples.push({
      observedAt: new Date(observed).toISOString(),
      remainingPercent: remaining,
      resetsAt: new Date(resets).toISOString(),
    });
    rows.push(item);
  }

  return { root: root!, snapshot: snapshot!, rows, samples };
}

/** Produces the sanitized state.json shape consumed by T3's read-only importer. */
export function appendCodexQuotaSample(
  priorText: string | null,
  sample: CodexQuotaSample,
  fetchedAt = sample.observedAt,
): string {
  const prior =
    priorText === null
      ? { root: {}, snapshot: {}, rows: [], samples: [] as CodexQuotaSample[] }
      : decodePrior(priorText);
  const observedAt = validIso(sample.observedAt);
  const resetsAt = validIso(sample.resetsAt);
  const fetchedAtMs = validIso(fetchedAt);
  if (
    observedAt === null ||
    resetsAt === null ||
    fetchedAtMs === null ||
    observedAt > resetsAt ||
    sample.remainingPercent < 0 ||
    sample.remainingPercent > 100 ||
    !Number.isFinite(sample.remainingPercent)
  ) {
    throw new Error("Quota sample is invalid.");
  }

  const normalized: CodexQuotaSample = {
    observedAt: new Date(observedAt).toISOString(),
    remainingPercent: sample.remainingPercent,
    resetsAt: new Date(resetsAt).toISOString(),
  };
  const existing = prior.samples.find((item) => item.observedAt === normalized.observedAt);
  if (
    existing &&
    (existing.remainingPercent !== normalized.remainingPercent ||
      existing.resetsAt !== normalized.resetsAt)
  ) {
    throw new Error("A conflicting quota sample already exists for this observation time.");
  }
  const rows = existing
    ? prior.rows
    : [
        ...prior.rows,
        {
          ObservedAt: normalized.observedAt,
          RemainingPercent: normalized.remainingPercent,
          ResetsAt: normalized.resetsAt,
        },
      ].sort((a, b) => String(a.ObservedAt).localeCompare(String(b.ObservedAt)));
  if (rows.length > MAX_SAMPLES) {
    throw new Error("Quota history is full; existing observations were left unchanged.");
  }
  return `${JSON.stringify(
    {
      ...prior.root,
      Snapshot: {
        ...prior.snapshot,
        MainLimit: {
          ...object(prior.snapshot.MainLimit),
          LimitId: "codex",
          Window: {
            ...object(object(prior.snapshot.MainLimit)?.Window),
            DurationMinutes: WEEK_MINUTES,
          },
        },
        FetchedAt: new Date(fetchedAtMs).toISOString(),
      },
      Samples: rows,
    },
    null,
    2,
  )}\n`;
}

/** Single-writer atomic replacement. launchd should schedule one collector per Mac. */
export async function appendCodexQuotaSampleFile(
  filePath: string,
  sample: CodexQuotaSample,
  fetchedAt = sample.observedAt,
): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const lock = await openSamplerLock(lockPath);
  const tempPath = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await lock.writeFile(String(process.pid), "utf8");
    const priorText = await NodeFSP.readFile(filePath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    let nextPriorText = priorText;
    if (priorText !== null) {
      const prior = decodePrior(priorText);
      const observedAtMs = validIso(sample.observedAt);
      if (
        prior.rows.length === MAX_SAMPLES &&
        observedAtMs !== null &&
        !prior.samples.some((entry) => Date.parse(entry.observedAt) === observedAtMs)
      ) {
        const orderedRows = [...prior.rows].sort(
          (a, b) => Date.parse(String(a.ObservedAt)) - Date.parse(String(b.ObservedAt)),
        );
        const archiveText = `${JSON.stringify({ Samples: orderedRows.slice(0, ARCHIVE_SAMPLES) })}\n`;
        const retainedText = JSON.stringify({
          ...prior.root,
          Samples: orderedRows.slice(ARCHIVE_SAMPLES),
        });
        // Validate the next active file before writing anything to the archive.
        appendCodexQuotaSample(retainedText, sample, fetchedAt);
        const archiveHash = NodeCrypto.createHash("sha256").update(archiveText).digest("hex");
        const archiveDir = `${filePath}.archive`;
        const archivePath = NodePath.join(archiveDir, `${archiveHash}.json`);
        await NodeFSP.mkdir(archiveDir, { recursive: true, mode: 0o700 });
        const archived = await NodeFSP.readFile(archivePath, "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (archived !== null && archived !== archiveText) {
          throw new Error("Existing quota archive differs from the observations being moved.");
        }
        if (archived === null) {
          const archiveTempPath = `${archivePath}.${NodeCrypto.randomUUID()}.tmp`;
          try {
            const archiveFile = await NodeFSP.open(archiveTempPath, "wx", 0o600);
            try {
              await archiveFile.writeFile(archiveText, "utf8");
              await archiveFile.sync();
            } finally {
              await archiveFile.close();
            }
            await NodeFSP.rename(archiveTempPath, archivePath);
          } finally {
            await NodeFSP.rm(archiveTempPath, { force: true });
          }
        }
        nextPriorText = retainedText;
      }
    }
    await NodeFSP.open(tempPath, "wx", 0o600).then(async (file) => {
      try {
        await file.writeFile(appendCodexQuotaSample(nextPriorText, sample, fetchedAt), "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
    });
    await NodeFSP.rename(tempPath, filePath);
  } finally {
    await NodeFSP.rm(tempPath, { force: true });
    await lock.close();
    await NodeFSP.rm(lockPath, { force: true });
  }
}

async function openSamplerLock(lockPath: string) {
  try {
    return await NodeFSP.open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const before = await NodeFSP.stat(lockPath).catch(() => null);
  const owner = await NodeFSP.readFile(lockPath, "utf8").catch(() => "");
  const pid = Number(owner);
  let running = Number.isSafeInteger(pid) && pid > 0;
  if (running) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      running = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  const after = await NodeFSP.stat(lockPath).catch(() => null);
  if (running || before === null || after === null || before.ino !== after.ino) {
    throw new Error("Quota sampler is already running.");
  }
  await NodeFSP.rm(lockPath);
  return openSamplerLock(lockPath);
}
