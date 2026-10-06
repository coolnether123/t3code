import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ComputerBadge } from "../ComputerBadge";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection, SettingResetButton } from "./settingsLayout";

function ComputerSettingsRows({ environment }: { environment: EnvironmentPresentation }) {
  const settings = useEnvironmentSettings(environment.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const editable =
    environment.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.computerAppearance === true;

  return (
    <div>
      <div className="px-4 py-2">
        <ComputerBadge
          environmentId={environment.environmentId}
          className="font-medium text-foreground"
        />
      </div>
      {!editable ? (
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          {environment.connection.phase === "connected"
            ? "Update this computer to change its name and color."
            : "Connect to this computer to change its settings."}
        </p>
      ) : null}
      <SettingsRow
        title="Computer name"
        description="Saved on this computer and shown on every device connected to it."
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
        description="Marks this computer's chats. The name stays visible too."
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
          <DraftInput
            nativeInput
            type="color"
            value={settings.environmentColor ?? environment.color}
            onCommit={(color) => updateSettings({ environmentColor: color })}
            aria-label={`Computer color for ${environment.label}`}
            disabled={!editable}
            className="h-9 w-14 cursor-pointer p-1"
          />
        }
      />
      <SettingsRow
        title="Show developer tools"
        description="Show Agent activity, project controls, Copy chat, project actions, Open, and Git controls."
        control={
          <Switch
            checked={settings.developerToolsEnabled}
            onCheckedChange={(enabled) =>
              updateSettings({ developerToolsEnabled: Boolean(enabled) })
            }
            aria-label={`Show developer tools for ${environment.label}`}
            disabled={!editable}
          />
        }
      />
    </div>
  );
}

export function ComputerSettings() {
  const { environments } = useEnvironments();
  return (
    <SettingsSection id="computers" title="Computers">
      {environments.length === 0 ? (
        <SettingsRow
          title="No connected computers"
          description="Add a computer in Settings > Connections."
        />
      ) : (
        environments.map((environment) => (
          <ComputerSettingsRows key={environment.environmentId} environment={environment} />
        ))
      )}
    </SettingsSection>
  );
}
