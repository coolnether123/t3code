import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { useGT } from "gt-react";
import { cn } from "../../lib/utils";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageBar } from "./ThreadDetailsUsage";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { resolveContextMeter } from "./contextMeter.logic";

export function ContextMeter({
  usage,
  claude,
  onOpen,
}: {
  readonly usage: ContextWindowSnapshot;
  readonly claude: boolean;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const { remaining, tone, nearCompact, threshold, ratio } = resolveContextMeter(usage);
  const count = usage.usedTokens.toLocaleString();
  const capacity = usage.maxTokens?.toLocaleString();
  const exact =
    capacity === undefined
      ? gt("{count} tokens used", { count })
      : gt("{count} of {capacity} tokens used", { count, capacity });
  const action = gt("Open thread details.");
  const until =
    remaining === null
      ? ""
      : gt("{count} until auto-compact.", { count: remaining.toLocaleString() });
  const compactText =
    remaining === null
      ? null
      : remaining === 0
        ? gt("compacts next turn")
        : gt("{count} to compact", { count: formatContextWindowTokens(remaining) });
  const barTone =
    tone === "error"
      ? "text-error-foreground"
      : tone === "warning"
        ? "text-warning-foreground"
        : undefined;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={gt("Context: {exact}. {until} {action}", { exact, until, action })}
            onClick={onOpen}
            className="ml-auto flex w-[15.5rem] shrink-0 items-center justify-end gap-1.5 whitespace-nowrap rounded text-xs tabular-nums text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @max-[1023px]/chat-header:w-[8.5rem] @max-[639px]/chat-header:w-[4.5rem]"
          ></button>
        }
      >
        <span className="@max-[1023px]/chat-header:hidden">{gt("Context")}</span>
        {ratio !== null && (
          <UsageBar
            fill={Math.min(100, ratio * 100)}
            tone={tone}
            tick={
              threshold !== null && usage.maxTokens ? (threshold / usage.maxTokens) * 100 : null
            }
            className="w-14 shrink-0 @max-[1023px]/chat-header:w-10 @max-[639px]/chat-header:hidden"
          />
        )}
        <span className={cn("text-foreground/80", tone === "error" && barTone)}>
          {formatContextWindowTokens(usage.usedTokens)}
          {usage.maxTokens != null && ` / ${formatContextWindowTokens(usage.maxTokens)}`}
        </span>
        {compactText !== null && (
          <span className={cn("@max-[1023px]/chat-header:hidden", barTone)}>· {compactText}</span>
        )}
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex flex-col gap-0.5">
          {ratio !== null && (
            <span>{gt("Context: {percent}% used", { percent: Math.round(ratio * 100) })}</span>
          )}
          <span>{exact}</span>
          <span>
            {ratio === null
              ? gt("This provider doesn't report its limit.")
              : threshold !== null
                ? formatContextWindowCompactionMessage(threshold)
                : claude
                  ? gt("Auto-compact is off for this chat.")
                  : gt("This provider doesn't report when it compacts.")}
          </span>
          {nearCompact && remaining !== 0 && (
            <span>{gt("The next long turn will compact this chat.")}</span>
          )}
          {usage.source === "compaction" &&
            usage.compactedAt !== null &&
            usage.totalProcessedTokens != null && (
              <span>
                {gt("Compacted at {time}: {before} → {after}.", {
                  time: new Date(usage.compactedAt).toLocaleTimeString("en-US", {
                    timeZone: "America/Chicago",
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                  before: formatContextWindowTokens(usage.totalProcessedTokens),
                  after: formatContextWindowTokens(usage.usedTokens),
                })}
              </span>
            )}
          <span>{action}</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
