import type { RememberedChatLocation } from "../uiStateStore";

interface ThreadLocationRef {
  readonly environmentId: string;
  readonly threadId: string;
  readonly archivedAt: string | null;
}

interface DraftLocationRef {
  readonly draftId: string;
  readonly environmentId: string;
}

interface ProjectLocationRef {
  readonly projectId: string;
  readonly environmentId: string;
}

export type EnvironmentSwitchTarget =
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "draft"; readonly draftId: string }
  | { readonly kind: "index" }
  | {
      readonly kind: "new-thread";
      readonly environmentId: string;
      readonly projectId: string;
    }
  | { readonly kind: "none" };

export function resolveEnvironmentSwitchTarget(input: {
  readonly environmentId: string | null;
  readonly rememberedLocation: RememberedChatLocation | null;
  readonly connectedEnvironmentIds: readonly string[];
  readonly threadRefs: readonly ThreadLocationRef[];
  readonly draftRefs: readonly DraftLocationRef[];
  readonly recentProjects: readonly ProjectLocationRef[];
}): EnvironmentSwitchTarget {
  const isConnected = (environmentId: string) =>
    input.connectedEnvironmentIds.includes(environmentId);
  if (input.environmentId !== null && !isConnected(input.environmentId)) {
    return { kind: "none" };
  }

  const remembered = input.rememberedLocation;
  if (remembered?.kind === "index") {
    return { kind: "index" };
  }
  if (
    remembered?.kind === "thread" &&
    (input.environmentId === null || remembered.environmentId === input.environmentId) &&
    isConnected(remembered.environmentId) &&
    input.threadRefs.some(
      (ref) =>
        ref.archivedAt === null &&
        ref.environmentId === remembered.environmentId &&
        ref.threadId === remembered.threadId,
    )
  ) {
    return {
      kind: "thread",
      environmentId: remembered.environmentId,
      threadId: remembered.threadId,
    };
  }
  if (
    remembered?.kind === "draft" &&
    (input.environmentId === null || remembered.environmentId === input.environmentId) &&
    isConnected(remembered.environmentId) &&
    input.draftRefs.some(
      (ref) => ref.environmentId === remembered.environmentId && ref.draftId === remembered.draftId,
    )
  ) {
    return { kind: "draft", draftId: remembered.draftId };
  }

  if (input.environmentId === null) {
    return { kind: "none" };
  }

  const project = input.recentProjects.find(
    (candidate) =>
      candidate.environmentId === input.environmentId && isConnected(candidate.environmentId),
  );
  return project
    ? {
        kind: "new-thread",
        environmentId: project.environmentId,
        projectId: project.projectId,
      }
    : { kind: "index" };
}
