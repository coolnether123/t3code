import type { ScopedThreadRef } from "@t3tools/contracts";
import { agentBrowserTabId } from "@t3tools/contracts";
import { Globe2Icon } from "lucide-react";

import { useAgentBrowserLeases } from "~/browser/agentBrowserLeases";
import { useRightPanelStore } from "~/rightPanelStore";
import { Badge } from "./ui/badge";

export function AgentBrowserBadge(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onOpen?: (() => void) | undefined;
}) {
  const leases = useAgentBrowserLeases(props.threadRef.environmentId);
  const lease = leases.find((lease) => lease.threadId === props.threadRef.threadId);
  if (!lease) return null;
  const page = lease.pages[0];
  return (
    <Badge
      render={<button type="button" />}
      size="sm"
      variant="info"
      aria-label="Watch agent browser"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        useRightPanelStore
          .getState()
          .openAgentBrowser(props.threadRef, agentBrowserTabId(lease.leaseId, page?.pageId ?? ""));
        props.onOpen?.();
      }}
    >
      <Globe2Icon />
      In browser
    </Badge>
  );
}
