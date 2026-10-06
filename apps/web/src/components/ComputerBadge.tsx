import { memo, type CSSProperties } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { computerAppearance } from "@t3tools/client-runtime/connection";

import { useEnvironment } from "../state/environments";
import { cn } from "../lib/utils";

/** Name and color of the computer that owns a chat, before and after it connects. */
export function useComputerIdentity(environmentId: EnvironmentId): { name: string; color: string } {
  const environment = useEnvironment(environmentId);
  const fallback = computerAppearance({
    environmentId,
    fallbackLabel: "Computer",
    serverConfig: null,
  });
  return {
    name: environment?.label ?? fallback.name,
    color: environment?.color ?? fallback.color,
  };
}

/** Colored left edge for a row, so a list of chats reads by computer at a glance. */
export function computerEdgeStyle(color: string): CSSProperties {
  return { boxShadow: `inset 3px 0 0 ${color}` };
}

export function ComputerIdentityBadge({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string | undefined;
}) {
  return (
    <span
      data-computer-name={name}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
      aria-label={`Computer: ${name}`}
    >
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full border border-foreground/30"
        style={{ backgroundColor: color }}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

export const ComputerBadge = memo(function ComputerBadge({
  environmentId,
  className,
}: {
  environmentId: EnvironmentId;
  className?: string | undefined;
}) {
  const computer = useComputerIdentity(environmentId);
  return (
    <ComputerIdentityBadge name={computer.name} color={computer.color} className={className} />
  );
});
