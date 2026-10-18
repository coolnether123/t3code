import type { CallModels, ModelSelection, ServerProvider } from "@t3tools/contracts";

/** Initial preferences only. Execution always uses the saved, catalog-validated selections. */
export function initialCallModels(
  providers: readonly ServerProvider[],
  current: ModelSelection,
): CallModels {
  const choose = (
    driver: string,
    preferred: string,
    optionId: string,
  ): ModelSelection | undefined => {
    const provider = providers.find(
      (entry) =>
        entry.driver === driver &&
        entry.enabled &&
        entry.installed &&
        entry.status === "ready" &&
        entry.availability !== "unavailable" &&
        entry.auth.status !== "unauthenticated" &&
        entry.models.some((model) => model.slug === preferred),
    );
    const model = provider?.models.find((entry) => entry.slug === preferred);
    if (!provider || !model) return undefined;
    const effort = model.capabilities?.optionDescriptors?.find((entry) => entry.id === optionId);
    return {
      instanceId: provider.instanceId,
      model: model.slug,
      ...(effort?.type === "select" && effort.options.some((entry) => entry.id === "medium")
        ? { options: [{ id: optionId, value: "medium" }] }
        : {}),
    };
  };
  return {
    voice: choose("claudeAgent", "claude-haiku-5-5", "effort") ?? current,
    operator: choose("codex", "gpt-6.1-sol", "reasoningEffort") ?? current,
  };
}
