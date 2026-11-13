import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

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

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

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

// T3 unsubscribes only when it unloads a thread; Codex's own unload delay would stack on that.
export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  "-c",
  "thread_unload_delay_secs=0",
  ...codexLaunchArgv(launchArgs),
];

interface LaunchArgFilter {
  readonly switches: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
  readonly inlinePrefixes: ReadonlyArray<string>;
}

const SHARED_VALUE_FLAGS = ["--config", "-c", "--enable", "--disable"];
const SHARED_INLINE_PREFIXES = ["--config=", "-c=", "--enable=", "--disable="];

const MCP_LIST_FILTER: LaunchArgFilter = {
  switches: new Set(),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--profile=", "-p="],
};

const EXEC_FILTER: LaunchArgFilter = {
  switches: new Set(["--strict-config", "--oss"]),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--local-provider", "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--local-provider=", "--profile=", "-p="],
};

const filterLaunchArgs = (launchArgs: string | undefined, allowed: LaunchArgFilter) => {
  const args = codexLaunchArgv(launchArgs);
  const kept: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (allowed.switches.has(arg)) {
      kept.push(arg);
    } else if (allowed.valueFlags.has(arg)) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        kept.push(arg, value);
        index++;
      }
    } else if (allowed.inlinePrefixes.some((prefix) => arg.startsWith(prefix))) {
      kept.push(arg);
    }
  }

  return kept;
};

export const codexExecLaunchArgs = (launchArgs?: string) =>
  filterLaunchArgs(launchArgs, EXEC_FILTER);

export const codexMcpListLaunchArgs = (launchArgs?: string) =>
  filterLaunchArgs(launchArgs, MCP_LIST_FILTER);
