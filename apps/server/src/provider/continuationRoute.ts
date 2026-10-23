import {
  resolveProviderInstanceEnabled,
  type ModelSelection,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";

/** Resolve the persisted Mac continuation setting before dispatch policy checks the destination. */
export function resolveContinuationRoute(
  instances: ProviderInstanceConfigMap,
  selection: ModelSelection,
): ModelSelection {
  const source = instances[selection.instanceId];
  const targetId = source?.continueThreadsOn;
  if (targetId === undefined || targetId === selection.instanceId) return selection;
  const target = instances[targetId];
  if (
    source?.driver !== "codex" ||
    target === undefined ||
    target.driver !== source.driver ||
    !resolveProviderInstanceEnabled(target)
  ) {
    throw new Error(
      `Continuation instance '${targetId}' must be enabled and use the Codex driver.`,
    );
  }
  return { ...selection, instanceId: targetId };
}
