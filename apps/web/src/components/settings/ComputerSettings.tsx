import { COMPUTER_COLORS } from "@t3tools/client-runtime/connection";

import { cn } from "../../lib/utils";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ComputerBadge } from "../ComputerBadge";
import { DraftInput } from "../ui/draft-input";
import { useEnvironmentOperateAccess } from "./EnvironmentIconPicker";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection, SettingResetButton } from "./settingsLayout";

/**
 * Why a computer's name and color can't be changed from here, or null when they can.
 * The computer serving this page is never "connected" like a saved remote, so this
 * reads its server config and session access the same way the icon picker does.
 */
export function resolveComputerSettingsLock(input: {
  readonly serverConfig: EnvironmentPresentation["serverConfig"];
  readonly operateAccess: "granted" | "denied" | "pending";
}): string | null {
  if (input.serverConfig === null) return "Connect to this computer to change its settings.";
  if (input.serverConfig.environment.capabilities.computerAppearance !== true) {
    return "Update this computer to change its name and color.";
  }
  if (input.operateAccess === "denied") {
    return "Your session on this computer cannot change its settings.";
  }
  return null;
}

function ComputerSettingsRows({ environment }: { environment: EnvironmentPresentation }) {
  const settings = useEnvironmentSettings(environment.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const lock = resolveComputerSettingsLock({
    serverConfig: environment.serverConfig,
    operateAccess: useEnvironmentOperateAccess(environment.environmentId),
  });
  const editable = lock === null;

  return (
    <div>
      <div className="px-4 py-2">
        <ComputerBadge
          environmentId={environment.environmentId}
          className="font-medium text-foreground"
        />
      </div>
      {lock ? <p className="px-4 pb-2 text-xs text-muted-foreground">{lock}</p> : null}
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
          <div className="flex flex-wrap items-center gap-2">
            {COMPUTER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                disabled={!editable}
                aria-label={`Use ${color} for ${environment.label}`}
                aria-pressed={environment.color === color}
                onClick={() => updateSettings({ environmentColor: color })}
                className={cn(
                  "size-7 shrink-0 rounded-full border-2 border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  environment.color === color && "border-foreground",
                )}
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
              className="h-9 w-14 cursor-pointer p-1"
            />
          </div>
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
