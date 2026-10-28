import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  Outlet,
  createFileRoute,
  redirect,
  useMatches,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

import { useThreadShell, useThreadStatus } from "../state/entities";
import { useComposerDraftStore } from "../composerDraftStore";
import { useSidebarEnvironmentScope } from "../hooks/useSidebarEnvironmentScope";
import {
  environmentChatLocationScopeKey,
  useUiStateStore,
  type RememberedChatLocation,
} from "../uiStateStore";

function EnvironmentChatLocationTracker() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeThreadEnvironmentId = routeThreadRef?.environmentId ?? null;
  const routeThreadId = routeThreadRef?.threadId ?? null;
  const threadShell = useThreadShell(routeThreadRef);
  const threadStatus = useThreadStatus(routeThreadRef);
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    routeDraftId ? store.getDraftSession(routeDraftId) : null,
  );
  const { environments, selectedEnvironmentId, setSelectedEnvironmentId } =
    useSidebarEnvironmentScope();
  const connectedEnvironmentIds = ((): ReadonlySet<string> =>
    new Set<string>(environments.map((environment) => environment.environmentId)))();
  const hasThreadShell = threadShell !== null;
  const draftEnvironmentId = draftSession?.environmentId ?? null;
  const draftIsUnpromoted = draftSession?.promotedTo == null;
  const routeLocation = ((): RememberedChatLocation | null => {
    if (pathname === "/") {
      return { kind: "index" };
    }
    if (routeThreadEnvironmentId && routeThreadId && hasThreadShell && threadStatus !== "deleted") {
      return {
        kind: "thread",
        environmentId: routeThreadEnvironmentId,
        threadId: routeThreadId,
      };
    }
    if (routeDraftId && draftEnvironmentId && draftIsUnpromoted) {
      return { kind: "draft", environmentId: draftEnvironmentId, draftId: routeDraftId };
    }
    return null;
  })();
  const routeLocationKey = routeLocation
    ? routeLocation.kind === "index"
      ? "index"
      : routeLocation.kind === "thread"
        ? `thread:${routeLocation.environmentId}:${routeLocation.threadId}`
        : `draft:${routeLocation.environmentId}:${routeLocation.draftId}`
    : null;
  const previousLocationRef = useRef<{
    readonly pathname: string;
    readonly routeLocationKey: string | null;
    readonly selectedEnvironmentId: string | null;
    readonly connectedEnvironmentIds: ReadonlySet<string>;
  } | null>(null);

  useEffect(() => {
    const previous = previousLocationRef.current;
    const routeChanged =
      previous === null ||
      previous.pathname !== pathname ||
      previous.routeLocationKey !== routeLocationKey;
    const scopeChanged =
      previous !== null && previous.selectedEnvironmentId !== selectedEnvironmentId;
    const routeEnvironmentJustConnected =
      previous !== null &&
      routeLocation !== null &&
      routeLocation.kind !== "index" &&
      connectedEnvironmentIds.has(routeLocation.environmentId) &&
      !previous.connectedEnvironmentIds.has(routeLocation.environmentId);
    previousLocationRef.current = {
      pathname,
      routeLocationKey,
      selectedEnvironmentId,
      connectedEnvironmentIds,
    };
    if (!routeLocation || (!routeChanged && !scopeChanged && !routeEnvironmentJustConnected))
      return;

    const uiState = useUiStateStore.getState();
    const remember = (environmentId: string | null) =>
      uiState.setLastChatLocationForScope(
        environmentChatLocationScopeKey(environmentId),
        routeLocation,
      );

    if (routeLocation.kind === "index") {
      remember(selectedEnvironmentId);
      return;
    }
    if (!connectedEnvironmentIds.has(routeLocation.environmentId)) return;

    if ((routeChanged || routeEnvironmentJustConnected) && selectedEnvironmentId !== null) {
      if (selectedEnvironmentId !== routeLocation.environmentId) {
        setSelectedEnvironmentId(routeLocation.environmentId);
      }
      remember(routeLocation.environmentId);
      return;
    }
    if (selectedEnvironmentId === null) {
      remember(null);
      remember(routeLocation.environmentId);
    } else if (selectedEnvironmentId === routeLocation.environmentId) {
      remember(routeLocation.environmentId);
    }
  }, [
    connectedEnvironmentIds,
    pathname,
    routeLocation,
    routeLocationKey,
    selectedEnvironmentId,
    setSelectedEnvironmentId,
  ]);

  return null;
}

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  // Settings and Usage render over the thread that opened them, so ChatView never remounts.
  const [backgroundTarget, setBackgroundTarget] = useState(threadTarget);
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(threadTarget)) {
    setBackgroundTarget(threadTarget);
  }
  const shownTarget = modalOpen ? backgroundTarget : threadTarget;
  return (
    <>
      <EnvironmentChatLocationTracker />
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
