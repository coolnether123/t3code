import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export type CodexConfigJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<CodexConfigJsonValue>
  | { readonly [key: string]: CodexConfigJsonValue };

export type CodexConfigOverridesParseResult =
  | {
      readonly _tag: "success";
      readonly config: Readonly<Record<string, CodexConfigJsonValue>>;
    }
  | {
      readonly _tag: "failure";
      readonly argument: string;
      readonly reason: string;
    };

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

const parseConfigValue = (
  rawValue: string,
):
  | { readonly _tag: "success"; readonly value: CodexConfigJsonValue }
  | {
      readonly _tag: "failure";
      readonly reason: string;
    } => {
  const value = rawValue.trim();
  if (value.length === 0) {
    return { _tag: "failure", reason: "the value is empty" };
  }
  if (value === "true" || value === "false") {
    return { _tag: "success", value: value === "true" };
  }
  if (value === "null") {
    return { _tag: "success", value: null };
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return { _tag: "success", value: number };
  }
  if (value.startsWith('"') || value.startsWith("[") || value.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        parsed === null ||
        typeof parsed === "boolean" ||
        typeof parsed === "number" ||
        typeof parsed === "string" ||
        Array.isArray(parsed) ||
        (typeof parsed === "object" && parsed !== null)
      ) {
        return { _tag: "success", value: parsed as CodexConfigJsonValue };
      }
    } catch {
      return {
        _tag: "failure",
        reason: "the value must be a valid JSON/TOML scalar, array, or object",
      };
    }
  }
  if (value.startsWith("'") || value.endsWith("'")) {
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      return { _tag: "success", value: value.slice(1, -1).replaceAll("''", "'") };
    }
    return { _tag: "failure", reason: "the quoted value is not closed" };
  }

  // Codex accepts unquoted TOML bare strings for convenient values such as
  // model names and URLs. Keep this fallback intentionally narrow: values
  // that look like structured TOML must parse instead of disappearing.
  if (value.startsWith("[") || value.startsWith("{")) {
    return {
      _tag: "failure",
      reason: "the value must be a valid JSON/TOML array or object",
    };
  }
  return { _tag: "success", value };
};

const parseConfigOverride = (
  rawOverride: string,
):
  | { readonly _tag: "success"; readonly key: string; readonly value: CodexConfigJsonValue }
  | {
      readonly _tag: "failure";
      readonly reason: string;
    } => {
  const separator = rawOverride.indexOf("=");
  if (separator <= 0) {
    return { _tag: "failure", reason: "it must use key=value syntax" };
  }
  const rawKey = rawOverride.slice(0, separator).trim();
  if (rawKey.length === 0) {
    return { _tag: "failure", reason: "the key is empty" };
  }
  const parsed = parseConfigValue(rawOverride.slice(separator + 1));
  if (parsed._tag === "failure") return parsed;
  return {
    _tag: "success",
    key: rawKey === "use_legacy_landlock" ? "features.use_legacy_landlock" : rawKey,
    value: parsed.value,
  };
};

/**
 * Converts Codex CLI config flags into the request-scoped config map accepted
 * by an already-running app-server daemon. The proxy subcommand cannot apply
 * process launch flags, so callers must either forward this map per thread or
 * report the unsupported argument explicitly.
 */
export function parseCodexConfigOverrides(
  args: ReadonlyArray<string>,
): CodexConfigOverridesParseResult {
  const config: Record<string, CodexConfigJsonValue> = {};
  const fail = (argument: string, reason: string): CodexConfigOverridesParseResult => ({
    _tag: "failure",
    argument,
    reason,
  });

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === undefined) continue;

    let rawOverride: string | undefined;
    if (argument === "-c" || argument === "--config") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return fail(argument, "it requires a following key=value argument");
      }
      rawOverride = value;
      index++;
    } else if (argument.startsWith("-c=") || argument.startsWith("--config=")) {
      rawOverride = argument.slice(argument.indexOf("=") + 1);
    } else if (argument === "--enable" || argument === "--disable") {
      const feature = args[index + 1];
      if (feature === undefined || feature.startsWith("-")) {
        return fail(argument, "it requires a following feature name");
      }
      config[`features.${feature}`] = argument === "--enable";
      index++;
      continue;
    } else if (argument.startsWith("--enable=") || argument.startsWith("--disable=")) {
      const feature = argument.slice(argument.indexOf("=") + 1);
      if (feature.length === 0) return fail(argument, "the feature name is empty");
      config[`features.${feature}`] = argument.startsWith("--enable=");
      continue;
    } else {
      return fail(argument, "the daemon proxy has no per-thread equivalent for this flag");
    }

    const parsed = parseConfigOverride(rawOverride);
    if (parsed._tag === "failure") return fail(rawOverride, parsed.reason);
    config[parsed.key] = parsed.value;
  }

  return { _tag: "success", config };
}

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};
