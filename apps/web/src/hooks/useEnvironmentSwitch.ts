import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  ALL_ENVIRONMENTS_CHAT_LOCATION_SCOPE,
  environmentChatLocationScopeKey,
  useUiStateStore,
} from "../uiStateStore";
import { resolveEnvironmentSwitchTarget } from "./environmentSwitch.logic";
import { useHandleNewThread } from "./useHandleNewThread";
import { useSidebarEnvironmentScope } from "./useSidebarEnvironmentScope";

/**
 * Picking an environment in the sidebar reopens the chat last used there. A pick made before
 * every environment's shell has loaded waits for it, so the remembered chat is not mistaken for
 * a deleted one.
 */
export function useEnvironmentSwitch() {
  const router = useRouter();
  const { environments, selectedEnvironmentId, setSelectedEnvironmentId } =
    useSidebarEnvironmentScope();
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const projects = useProjects();
  const threads = useThreadShells();
  const { handleNewThread } = useHandleNewThread();
  const pendingValue = useRef<string | null>(null);

  const switchEnvironment = (value: string) => {
    const targetEnvironmentId = value === ALL_ENVIRONMENTS_CHAT_LOCATION_SCOPE ? null : value;
    if (targetEnvironmentId === selectedEnvironmentId) {
      pendingValue.current = null;
      return;
    }
    const connectedEnvironmentIds = environments.map((environment) => environment.environmentId);
    if (
      targetEnvironmentId !== null &&
      !connectedEnvironmentIds.some((environmentId) => environmentId === targetEnvironmentId)
    ) {
      pendingValue.current = null;
      return;
    }
    if (!shellsBootstrapped) {
      pendingValue.current = value;
      return;
    }
    pendingValue.current = null;

    const scopeKey = environmentChatLocationScopeKey(targetEnvironmentId);
    const uiState = useUiStateStore.getState();
    const draftRefs = Object.entries(useComposerDraftStore.getState().draftThreadsByThreadKey)
      .filter(([, draft]) => draft.promotedTo == null)
      .map(([draftId, draft]) => ({ draftId, environmentId: draft.environmentId }));
    const target = resolveEnvironmentSwitchTarget({
      environmentId: targetEnvironmentId,
      rememberedLocation: uiState.lastChatLocationByScope[scopeKey] ?? null,
      connectedEnvironmentIds,
      threadRefs: threads.map((thread) => ({
        environmentId: thread.environmentId,
        threadId: thread.id,
        archivedAt: thread.archivedAt,
      })),
      draftRefs,
      recentProjects: sortScopedProjectsForSidebar(projects, threads, "updated_at").map(
        (project) => ({ projectId: project.id, environmentId: project.environmentId }),
      ),
    });

    setSelectedEnvironmentId(value);

    switch (target.kind) {
      case "none":
        uiState.setLastChatLocationForScope(scopeKey, null);
        return;
      case "thread":
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(
              EnvironmentId.make(target.environmentId),
              ThreadId.make(target.threadId),
            ),
          ),
        });
        return;
      case "draft":
        void router.navigate({
          to: "/draft/$draftId",
          params: { draftId: DraftId.make(target.draftId) },
        });
        return;
      case "index":
        void router.navigate({ to: "/" });
        return;
      case "new-thread":
        // The index landing starts its own draft when the selected scope changes.
        if (router.state.location.pathname === "/") return;
        void startNewThreadFromContext({
          activeDraftThread: null,
          activeThread: undefined,
          defaultProjectRef: scopeProjectRef(
            EnvironmentId.make(target.environmentId),
            ProjectId.make(target.projectId),
          ),
          handleNewThread,
          selectedEnvironmentId: EnvironmentId.make(target.environmentId),
        });
    }
  };

  useEffect(() => {
    if (pendingValue.current === null || !shellsBootstrapped) return;
    switchEnvironment(pendingValue.current);
  }, [shellsBootstrapped, switchEnvironment]);

  return switchEnvironment;
}
