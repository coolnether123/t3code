import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { COMPUTER_COLORS } from "@t3tools/client-runtime/connection";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ComputerBadge } from "../ComputerBadge";
import { DraftInput } from "../ui/draft-input";
import { SettingsRow, SettingsSection, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function ComputerSettingsRows({ environment }: { environment: EnvironmentPresentation }) {
  const settings = useEnvironmentSettings(environment.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const canWrite = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const editable =
    canWrite && environment.serverConfig?.environment.capabilities.computerAppearance === true;
  return (
    <div>
      <div className="px-4 py-2">
        <ComputerBadge environmentId={environment.environmentId} />
      </div>
      <SettingsRow
        title="Computer name"
        description="Saved on this computer and shown on every connected device."
        control={
          <DraftInput
            value={settings.environmentName}
            placeholder={environment.serverConfig?.environment.label ?? environment.label}
            onCommit={(name) => updateSettings({ environmentName: name.trim() })}
            aria-label={`Computer name for ${environment.label}`}
            disabled={!editable}
            className="w-full sm:w-48"
          />
        }
      />
      <SettingsRow
        title="Computer color"
        description="Marks this computer's chats."
        resetAction={
          settings.environmentColor !== null ? (
            <SettingResetButton
              label={`${environment.label} computer color`}
              disabled={!editable}
              onClick={() => updateSettings({ environmentColor: null })}
            />
          ) : null
        }
        control={
          <div className="flex flex-wrap items-center gap-2">
            {COMPUTER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                disabled={!editable}
                aria-label={`Use ${color} for ${environment.label}`}
                aria-pressed={environment.color === color}
                onClick={() => updateSettings({ environmentColor: color })}
                className="size-7 shrink-0 rounded-full border-2 border-foreground/30 disabled:opacity-50"
                style={{ backgroundColor: color }}
              />
            ))}
            <DraftInput
              nativeInput
              type="color"
              value={settings.environmentColor ?? environment.color}
              onCommit={(color) => updateSettings({ environmentColor: color })}
              aria-label={`Computer color for ${environment.label}`}
              disabled={!editable}
              className="h-9 w-14 cursor-pointer"
            />
          </div>
        }
      />
    </div>
  );
}

export function ComputerSettings() {
  const { environments } = useEnvironments();
  return (
    <SettingsSection id={searchableSetting("computers").id} title="Computers">
      {environments.map((environment) => (
        <ComputerSettingsRows key={environment.environmentId} environment={environment} />
      ))}
    </SettingsSection>
  );
}
