import { memo } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { computerAppearance } from "@t3tools/client-runtime/connection";

import { useEnvironment } from "../state/environments";
import { cn } from "../lib/utils";

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
  const environment = useEnvironment(environmentId);
  const fallback = computerAppearance({
    environmentId,
    fallbackLabel: "Computer",
    serverConfig: null,
  });
  return (
    <ComputerIdentityBadge
      name={environment?.label ?? fallback.name}
      color={environment?.color ?? fallback.color}
      className={className}
    />
  );
});
