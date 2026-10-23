import type { EnvironmentId, ProviderInstanceConfig, ProviderInstanceId } from "@t3tools/contracts";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { SettingsRow } from "./settingsLayout";

export function ProviderContinuationSettings({
  environmentId,
  instanceId,
  instance,
  disabled,
  onUpdate,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  instance: ProviderInstanceConfig;
  disabled: boolean;
  onUpdate: (instance: ProviderInstanceConfig) => void;
}) {
  const instances = useEnvironmentSettings(environmentId, (settings) => settings.providerInstances);
  const choices = Object.entries(instances).filter(
    ([id, candidate]) => id !== instanceId && candidate.driver === "codex",
  );
  const missing =
    instance.continueThreadsOn !== undefined &&
    !choices.some(([id]) => id === instance.continueThreadsOn);
  return (
    <SettingsRow
      title="Continue its chats on"
      description="Use this Codex instance for the next turn of this instance's chats."
      control={
        <select
          disabled={disabled}
          value={instance.continueThreadsOn ?? ""}
          aria-label={`Continue ${instance.displayName ?? instanceId} chats on`}
          className="min-h-9 min-w-36 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          onChange={(event) => {
            const { continueThreadsOn: _previous, ...rest } = instance;
            onUpdate(
              event.target.value
                ? { ...rest, continueThreadsOn: event.target.value as ProviderInstanceId }
                : rest,
            );
          }}
        >
          <option value="">None</option>
          {missing ? (
            <option value={instance.continueThreadsOn}>
              {instance.continueThreadsOn} unavailable
            </option>
          ) : null}
          {choices.map(([id, candidate]) => (
            <option key={id} value={id}>
              {candidate.displayName ?? id}
            </option>
          ))}
        </select>
      }
    />
  );
}
