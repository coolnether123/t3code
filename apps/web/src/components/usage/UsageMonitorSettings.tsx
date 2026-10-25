import { Settings2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface Computer {
  readonly id: string;
  readonly label: string;
}

const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function UsageMonitorSettings({
  sources,
  sourceId,
  onSourceChange,
  computers,
  includedIds,
  onIncludedChange,
  monitoringSince,
  readingCount,
  subscription,
  onSubscriptionChange,
  canEditSubscription,
}: {
  readonly sources: readonly Computer[];
  readonly sourceId: string | undefined;
  readonly onSourceChange: (id: string) => void;
  readonly computers: readonly Computer[];
  readonly includedIds: readonly string[] | null;
  readonly onIncludedChange: (ids: readonly string[]) => void;
  readonly monitoringSince: string | null;
  readonly readingCount: number;
  readonly subscription: {
    readonly plan: string;
    readonly monthlyUsd: number;
    readonly startDate: string;
  };
  readonly canEditSubscription: boolean;
  readonly onSubscriptionChange: (value: {
    plan: string;
    monthlyUsd: number;
    startDate: string;
  }) => void;
}) {
  const included = (id: string) => includedIds === null || includedIds.includes(id);
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Monitor settings"
        render={
          <Button variant="ghost" size="icon-sm" className="size-9" title="Monitor settings" />
        }
      >
        <Settings2Icon aria-hidden className="size-4" />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[min(22rem,calc(100vw-2rem))]" padding="none">
        <div className="space-y-4 p-4">
          <fieldset className="space-y-2 text-sm" disabled={!canEditSubscription}>
            <legend>Subscription</legend>
            <label className="flex flex-col gap-1">
              Plan
              <Input
                key={subscription.plan}
                defaultValue={subscription.plan}
                onBlur={(event) => {
                  if (event.target.value.trim())
                    onSubscriptionChange({ ...subscription, plan: event.target.value.trim() });
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              Monthly price ($)
              <Input
                key={subscription.monthlyUsd}
                type="number"
                min="0"
                max="100000"
                step="0.01"
                defaultValue={subscription.monthlyUsd}
                onBlur={(event) => {
                  const monthlyUsd = event.target.valueAsNumber;
                  if (event.target.validity.valid && Number.isFinite(monthlyUsd) && monthlyUsd >= 0)
                    onSubscriptionChange({ ...subscription, monthlyUsd });
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              Started
              <Input
                type="date"
                value={subscription.startDate}
                onChange={(event) => {
                  if (event.target.validity.valid && event.target.value)
                    onSubscriptionChange({ ...subscription, startDate: event.target.value });
                }}
              />
            </label>
          </fieldset>
          {sources.length > 1 ? (
            <label className="flex flex-col gap-1.5 text-sm">
              Saved readings from
              <select
                className="min-h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                value={sourceId}
                onChange={(event) => onSourceChange(event.target.value)}
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {computers.length > 0 ? (
            <fieldset className="space-y-1">
              <legend className="text-sm">Transcripts priced for API value</legend>
              {computers.map((computer) => (
                <label key={computer.id} className="flex min-h-8 items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0"
                    checked={included(computer.id)}
                    onChange={(event) => {
                      const ids = new Set(
                        includedIds ?? computers.map((candidate) => candidate.id),
                      );
                      if (event.target.checked) ids.add(computer.id);
                      else ids.delete(computer.id);
                      onIncludedChange([...ids]);
                    }}
                  />
                  <span className="break-words">{computer.label}</span>
                </label>
              ))}
              <p className="pt-1 text-xs text-muted-foreground">
                Include only computers signed in to the same account. Percentages are never added
                across computers.
              </p>
            </fieldset>
          ) : null}
          <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
            {monitoringSince
              ? `Monitoring since ${dateTime(monitoringSince)} · ${readingCount.toLocaleString()} readings. `
              : ""}
            Codex readings come from the Codex Limits tracker; Claude readings are taken by this
            computer's T3 server through the Claude CLI. Dollar amounts are API-equivalent
            estimates, not bills.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
