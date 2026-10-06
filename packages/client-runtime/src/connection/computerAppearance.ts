import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

const COMPUTER_COLORS = ["#2563eb", "#9333ea", "#0d9488", "#e11d48", "#d97706", "#0891b2"];

/** Read identity from the computer's settings, with stable defaults for older servers. */
export function computerAppearance(input: {
  readonly environmentId: EnvironmentId;
  readonly fallbackLabel: string;
  readonly serverConfig: {
    readonly environment: Pick<ServerConfig["environment"], "label">;
    readonly settings: Pick<ServerConfig["settings"], "environmentName" | "environmentColor">;
  } | null;
}): { name: string; color: string } {
  let hash = 0;
  for (const character of input.environmentId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return {
    name:
      input.serverConfig?.settings.environmentName ||
      input.serverConfig?.environment.label ||
      input.fallbackLabel,
    color:
      input.serverConfig?.settings.environmentColor ??
      COMPUTER_COLORS[hash % COMPUTER_COLORS.length]!,
  };
}
