import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

export const CONTEXT_WARNING_RATIO = 0.8;
export const CONTEXT_ERROR_RATIO = 0.9;

export function resolveContextMeter(
  usage: Pick<ContextWindowSnapshot, "usedTokens" | "maxTokens" | "autoCompactThreshold">,
) {
  const { usedTokens, maxTokens } = usage;
  const threshold =
    usage.autoCompactThreshold && usage.autoCompactThreshold > 0
      ? usage.autoCompactThreshold
      : null;
  const ratio = maxTokens && maxTokens > 0 ? usedTokens / maxTokens : null;
  const nearCompact = threshold !== null && usedTokens >= threshold * CONTEXT_ERROR_RATIO;
  const remaining = threshold === null ? null : Math.max(0, threshold - usedTokens);
  const tone =
    threshold !== null
      ? nearCompact
        ? "warning"
        : null
      : ratio !== null && ratio >= CONTEXT_ERROR_RATIO
        ? "error"
        : ratio !== null && ratio >= CONTEXT_WARNING_RATIO
          ? "warning"
          : null;
  return { remaining, tone, nearCompact, threshold, ratio } as const;
}
