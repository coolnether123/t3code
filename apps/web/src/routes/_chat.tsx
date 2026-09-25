import {
  Outlet,
  createFileRoute,
  redirect,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useClientSettings, useLegacySidebarEnabled } from "../hooks/useSettings";
import { openCommandPalette } from "../commandPaletteBus";
import { useProjects, useThreadShell, useThreadStatus } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSidebarEnvironmentScope } from "../hooks/useSidebarEnvironmentScope";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import {
  environmentChatLocationScopeKey,
  useUiStateStore,
  type RememberedChatLocation,
} from "../uiStateStore";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { primaryServerKeybindingsAtom } from "~/state/server";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeThreadRef,
    selectedEnvironmentId,
  } = useHandleNewThread();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupCount = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: projects.filter(
          (project) =>
            selectedEnvironmentId === null || project.environmentId === selectedEnvironmentId,
        ),
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).length,
    [primaryEnvironmentId, projectGroupingSettings, projects, selectedEnvironmentId],
  );
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  // The `previewOpen` shortcut-context flag here uses the store-only value;
  // the URL-aware arbitration lives inside ChatView's `onTogglePreview`,
  // which we invoke via the action bus to avoid duplicating the rule.
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
        },
      });

      if (isCommandPaletteOpen()) {
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        if (projectGroupCount === 0) {
          openCommandPalette({ open: "add-project" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
          selectedEnvironmentId,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        if (projectGroupCount === 0) {
          openCommandPalette({ open: "add-project" });
          return;
        }
        // The default sidebar routes creation through the command palette
        // whenever there is a real choice to make; the legacy sidebar (and
        // single-project setups) keep the immediate contextual create.
        if (!legacySidebarEnabled && projectGroupCount > 1) {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
          selectedEnvironmentId,
        });
        return;
      }

      if (command === "preview.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!routeThreadRef) return;
        if (!isPreviewSupportedInRuntime()) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open T3 Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
        return;
      }

      // The remaining preview commands only fire when the panel is the
      // currently-focused tenant. The `when: previewFocus` rule already
      // gates this, but defend against the keybinding being misconfigured.
      if (
        command === "preview.refresh" ||
        command === "preview.focusUrl" ||
        command === "preview.zoomIn" ||
        command === "preview.zoomOut" ||
        command === "preview.resetZoom"
      ) {
        event.preventDefault();
        event.stopPropagation();
        const action =
          command === "preview.refresh"
            ? "refresh"
            : command === "preview.focusUrl"
              ? "focus-url"
              : command === "preview.zoomIn"
                ? "zoom-in"
                : command === "preview.zoomOut"
                  ? "zoom-out"
                  : "reset-zoom";
        dispatchPreviewAction(action);
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    selectedEnvironmentId,
    previewOpen,
    projectGroupCount,
    routeThreadRef,
    selectedThreadKeysSize,
    legacySidebarEnabled,
    terminalOpen,
  ]);

  return null;
}

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
  const connectedEnvironmentIds = useMemo<ReadonlySet<string>>(
    () => new Set<string>(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const hasThreadShell = threadShell !== null;
  const draftEnvironmentId = draftSession?.environmentId ?? null;
  const draftIsUnpromoted = draftSession?.promotedTo == null;
  const routeLocation = useMemo<RememberedChatLocation | null>(() => {
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
  }, [
    draftEnvironmentId,
    draftIsUnpromoted,
    hasThreadShell,
    pathname,
    routeDraftId,
    routeThreadEnvironmentId,
    routeThreadId,
    threadStatus,
  ]);
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

function ChatRouteLayout() {
  return (
    <>
      <EnvironmentChatLocationTracker />
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
