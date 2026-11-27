import type { OtisFront } from "@t3tools/contracts";
import { PhoneIcon } from "lucide-react";
import { useGT } from "gt-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { otisContext } from "./front.logic";

export function FrontTopBar({
  state,
  canCall,
  onCall,
  onStart,
}: {
  state: OtisFront.FrontState | null;
  canCall: boolean;
  onCall: boolean;
  onStart: () => void;
}) {
  const gt = useGT();
  const phrases = {
    working: gt("Otis #1 working"),
    listening: gt("Otis #1 listening"),
    "idle-unreachable": gt("Otis #1 not listening"),
    unknown: gt("Otis #1 status unknown"),
  };
  const otis = state?.otis1;
  const context = otis && otisContext(otis);
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border pr-3 pl-12">
      <h1 className="text-sm font-semibold">{gt("Otis")}</h1>
      {state && otis && (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
          <Tooltip>
            <TooltipTrigger render={<span className="hidden @md:inline" />}>
              {phrases[otis.state]}
            </TooltipTrigger>
            <TooltipPopup>
              <div>
                {gt("{model}, {effort}.", {
                  model: otis.model,
                  effort: otis.effort ?? gt("effort not reported"),
                })}
              </div>
              {context && (
                <div>
                  {gt("Context {used} of {limit}.", { used: context[0]!, limit: context[1]! })}
                </div>
              )}
              {otis.reachVia && <div>{gt("Reached by {via}.", { via: otis.reachVia })}</div>}
              <div>
                {gt("{count, plural, one {# handoff open.} other {# handoffs open.}}", {
                  count: otis.activeHandoffs,
                })}
              </div>
            </TooltipPopup>
          </Tooltip>
          {(state.working.length > 0 || state.waiting.length > 0) && (
            <span aria-hidden="true" className="hidden @md:inline">
              ·
            </span>
          )}
          {state.working.length > 0 && (
            <span className={state.waiting.length ? "hidden @xs:inline" : undefined}>
              {gt("{count} running", { count: state.working.length })}
            </span>
          )}
          {state.waiting.length > 0 && (
            <span>
              {state.working.length > 0 && (
                <span aria-hidden="true" className="mr-1.5 hidden @xs:inline">
                  ·
                </span>
              )}
              {gt("{count, plural, one {# needs you} other {# need you}}", {
                count: state.waiting.length,
              })}
            </span>
          )}
        </div>
      )}
      {!onCall && (
        <div className="ml-auto">
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <Button size="sm" variant="ghost" disabled={!canCall} onClick={onStart}>
                <PhoneIcon />
                {gt("Call")}
              </Button>
            </TooltipTrigger>
            {!canCall && (
              <TooltipPopup>
                {gt("This device can't start calls. Pair it with full access.")}
              </TooltipPopup>
            )}
          </Tooltip>
        </div>
      )}
    </header>
  );
}
