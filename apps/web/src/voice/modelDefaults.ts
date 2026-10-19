import type { CallModels, ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { CallSelectorCatalog } from "../components/chat/CallModelSelectors";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";

/** Initial preferences only. Execution always uses the saved, catalog-validated selections. */
export function initialCallModels(
  providers: readonly ServerProvider[],
  current: ModelSelection,
  catalog: CallSelectorCatalog,
  defaultSelection?: ModelSelection | null,
  remembered?: CallModels,
  savedDefaults?: CallModels,
): CallModels {
  const visible = (selection: ModelSelection | null | undefined): selection is ModelSelection =>
    !!selection &&
    catalog.instanceEntries.some(
      (entry) => entry.enabled && entry.instanceId === selection.instanceId,
    ) &&
    !!catalog.modelOptionsByInstance
      .get(selection.instanceId)
      ?.some((model) => model.slug === selection.model && !model.isUnavailable);
  const first = catalog.instanceEntries.flatMap((entry) =>
    entry.enabled
      ? (catalog.modelOptionsByInstance.get(entry.instanceId) ?? [])
          .filter((model) => !model.isUnavailable)
          .map((model) => ({ instanceId: entry.instanceId, model: model.slug }))
      : [],
  )[0];
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
  const resolve = (role: keyof CallModels, seed: ModelSelection) =>
    [remembered?.[role] ?? seed, savedDefaults?.[role], defaultSelection, first].find(visible) ??
    NO_PROVIDER_MODEL_SELECTION;
  return {
    voice: resolve("voice", choose("claudeAgent", "claude-haiku-5-5", "effort") ?? current),
    operator: resolve("operator", current),
  };
}
