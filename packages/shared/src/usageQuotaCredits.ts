import type { UsageQuotaCredits } from "@t3tools/contracts";

export function decodeQuotaCredits(value: unknown): UsageQuotaCredits | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const credits = value as Record<string, unknown>;
  if (typeof credits.hasCredits !== "boolean" || typeof credits.unlimited !== "boolean")
    return undefined;
  const balance = typeof credits.balance === "number" ? String(credits.balance) : credits.balance;
  if (
    balance != null &&
    (typeof balance !== "string" ||
      balance.length > 40 ||
      !/^-?\d+(?:\.\d+)?$/.test(balance) ||
      !Number.isFinite(Number(balance)))
  )
    return undefined;
  return { hasCredits: credits.hasCredits, unlimited: credits.unlimited, balance: balance ?? null };
}
