import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useUiStateStore } from "../uiStateStore";

export function resolveSidebarEnvironmentScope(
  savedId: string | null,
  primaryId: EnvironmentId | null,
  availableIds: readonly EnvironmentId[],
): EnvironmentId | null {
  if (savedId === "all") return null;
  if (savedId !== null && availableIds.some((id) => id === savedId)) {
    return availableIds.find((id) => id === savedId)!;
  }
  return primaryId ?? availableIds[0] ?? null;
}

export function useSidebarEnvironmentScope() {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const savedId = useUiStateStore((state) => state.sidebarEnvironmentScopeId);
  const setSavedId = useUiStateStore((state) => state.setSidebarEnvironmentScopeId);
  return {
    environments,
    selectedEnvironmentId: resolveSidebarEnvironmentScope(
      savedId,
      primaryId,
      environments.map((environment) => environment.environmentId),
    ),
    setSelectedEnvironmentId: setSavedId,
  };
}
