import type { ClientSettings } from "@t3tools/contracts";
import { useClientSettings } from "./useSettings";

export function codingChromeHidden(settings: Pick<ClientSettings, "agentInterface">): boolean {
  return settings.agentInterface;
}

export function useAgentInterface(): boolean {
  return useClientSettings(codingChromeHidden);
}
