import type {
  CallModels,
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { TraitsPicker } from "./TraitsPicker";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

export interface CallSelectorCatalog {
  instanceEntries: readonly ProviderInstanceEntry[];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, readonly ModelEsque[]>;
}
export function CallModelSelectors(
  props: CallSelectorCatalog & {
    environmentId: EnvironmentId;
    models: CallModels;
    onChange(models: CallModels): void;
    disabled?: boolean;
  },
) {
  const select = (role: keyof CallModels, selection: ModelSelection) =>
    props.onChange({ ...props.models, [role]: selection });
  return (
    <div className="grid min-w-0 gap-2" aria-label="Call models">
      {(["voice", "operator"] as const).map((role) => {
        const selection = props.models[role];
        const entry = props.instanceEntries.find(
          (entry) => entry.instanceId === selection.instanceId,
        );
        return (
          <div key={role} className="flex min-w-0 flex-wrap items-center gap-1">
            <span className="w-full text-xs">
              {role === "voice" ? "Voice model" : "Background agent"}
            </span>
            <ProviderModelPicker
              environmentId={props.environmentId}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={props.instanceEntries}
              modelOptionsByInstance={props.modelOptionsByInstance}
              disabled={props.disabled ?? false}
              triggerAriaLabel={role === "voice" ? "Choose voice model" : "Choose background agent"}
              onInstanceModelChange={(instanceId, model) => select(role, { instanceId, model })}
            />
            {entry ? (
              <TraitsPicker
                provider={entry.driverKind}
                instanceId={selection.instanceId}
                models={entry.models}
                model={selection.model}
                modelOptions={selection.options}
                allowPromptInjectedEffort={false}
                planModeEnabled={false}
                disabled={props.disabled ?? false}
                onModelOptionsChange={(options) =>
                  select(role, { ...selection, ...(options ? { options } : { options: [] }) })
                }
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
