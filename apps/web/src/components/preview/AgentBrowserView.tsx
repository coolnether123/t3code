import { agentBrowserTabId, type ScopedThreadRef } from "@t3tools/contracts";
import { PictureInPicture2Icon } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";

import { useAgentBrowserLeases } from "~/browser/agentBrowserLeases";
import { ServerBrowserSurface, type ServerBrowserHandle } from "~/browser/ServerBrowserSurface";
import {
  closeServerPictureInPicture,
  openServerPictureInPicture,
  serverPictureInPictureKey,
  supportsServerPictureInPicture,
  useServerPictureInPictureKey,
} from "~/browser/serverPictureInPicture";
import { useRightPanelStore } from "~/rightPanelStore";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const subscribeVisibility = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};
const documentVisible = () => !document.hidden;

export function AgentBrowserView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly visible: boolean;
}) {
  const leases = useAgentBrowserLeases(props.threadRef.environmentId);
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible, () => false);
  const pages = leases
    .filter((lease) => lease.threadId === props.threadRef.threadId)
    .flatMap((lease) =>
      lease.pages.map((page) => ({
        ...page,
        tabId: agentBrowserTabId(lease.leaseId, page.pageId),
      })),
    );
  const page = pages.find(
    (page) =>
      page.tabId === props.tabId ||
      (props.tabId.endsWith(":") && page.tabId.startsWith(props.tabId)),
  );
  const tabId = page?.tabId ?? props.tabId;
  const surface = useRef<ServerBrowserHandle | null>(null);
  const pipKey = useServerPictureInPictureKey();
  const inPip = pipKey === serverPictureInPictureKey(props.threadRef.threadId, tabId);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <Tooltip>
            <TooltipTrigger render={<div className="truncate text-sm" />}>
              {page?.title || "Agent browser"}
            </TooltipTrigger>
            <TooltipPopup>{page?.title || "Agent browser"}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<div className="truncate text-xs text-muted-foreground" />}>
              {page?.url}
            </TooltipTrigger>
            <TooltipPopup>{page?.url}</TooltipPopup>
          </Tooltip>
        </div>
        {page && supportsServerPictureInPicture() ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={inPip ? "Close picture in picture" : "Open picture in picture"}
            onClick={() => {
              if (inPip) closeServerPictureInPicture();
              else
                void openServerPictureInPicture({
                  ...props.threadRef,
                  tabId,
                  seed: surface.current?.canvas() ?? null,
                }).catch(() =>
                  toastManager.add({ type: "error", title: "Could not open picture in picture" }),
                );
            }}
          >
            <PictureInPicture2Icon />
          </Button>
        ) : null}
      </div>
      {pages.length > 1 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1">
          {pages.map((entry) => (
            <Button
              key={entry.tabId}
              size="xs"
              variant={entry.tabId === props.tabId ? "secondary" : "ghost"}
              onClick={() =>
                useRightPanelStore.getState().openAgentBrowser(props.threadRef, entry.tabId)
              }
            >
              {entry.title || entry.url || "Page"}
            </Button>
          ))}
        </div>
      ) : null}
      {page ? (
        <ServerBrowserSurface
          ref={surface}
          environmentId={props.threadRef.environmentId}
          threadId={props.threadRef.threadId}
          tabId={tabId}
          visible={props.visible && visible}
          readOnly
          followSize={false}
          className="min-h-0 flex-1"
        />
      ) : (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          This browser page is no longer available. The agent may have closed it.
        </p>
      )}
    </div>
  );
}
