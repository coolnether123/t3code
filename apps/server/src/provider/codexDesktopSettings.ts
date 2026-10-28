import {
  CodexSettings,
  providerInstanceConfigEnabledFlag,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownOption(CodexSettings);
const defaults = Schema.decodeSync(CodexSettings)({});

export function codexDesktopSettings(settings: Pick<ServerSettings, "providerInstances">) {
  for (const entry of Object.values(settings.providerInstances)) {
    if (
      entry.driver !== "codex" ||
      entry.enabled === false ||
      providerInstanceConfigEnabledFlag(entry.config) === false
    )
      continue;
    const config = decode(entry.config ?? {});
    if (Option.isSome(config) && config.value.useDesktopAppDaemon) return config.value;
  }
  return { ...defaults, enabled: false };
}
