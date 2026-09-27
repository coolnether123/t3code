import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as CodexErrors from "effect-codex-app-server/errors";

import { expandHomePath } from "../pathExpansion.ts";

interface PluginConfig {
  readonly source: string | undefined;
  readonly enabledPlugins: ReadonlyArray<string>;
}

class DesktopPluginSkillError extends Data.TaggedError("DesktopPluginSkillError")<{
  readonly reason: string;
}> {}

const tomlString = (value: string): string => {
  const trimmed = value.trim();
  if (/^'[^']*'$/u.test(trimmed)) return trimmed.slice(1, -1);
  if (/^"(?:\\.|[^"\\])*"$/u.test(trimmed)) {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
  }
  throw new Error("invalid bundled marketplace config.toml string");
};

/** Reads only the marketplace and plugin-enable tables needed by the desktop bridge. */
export function parseCodexDesktopPluginConfig(text: string): PluginConfig {
  let table: "marketplace" | string | undefined;
  let sourceType: string | undefined;
  let source: string | undefined;
  const enabled = new Map<string, boolean>();

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      table = trimmed === "[marketplaces.openai-bundled]" ? "marketplace" : undefined;
      const plugin = trimmed.match(/^\[plugins\."([A-Za-z0-9_-]+)@openai-bundled"\]$/u);
      if (plugin) table = plugin[1];
      continue;
    }
    if (table === undefined) continue;
    const assignment = trimmed.match(/^([A-Za-z_]+)\s*=\s*(.*?)\s*(?:#.*)?$/u);
    if (!assignment) {
      if (/^(source|source_type|enabled)\s*=/u.test(trimmed)) {
        throw new Error("invalid bundled marketplace config.toml assignment");
      }
      continue;
    }
    const [, key, value] = assignment;
    if (table === "marketplace") {
      if (key === "source_type") sourceType = tomlString(value!);
      if (key === "source") source = tomlString(value!);
    } else if (key === "enabled") {
      if (value !== "true" && value !== "false") {
        throw new Error("invalid bundled plugin enabled value in config.toml");
      }
      enabled.set(table, value === "true");
    }
  }

  return {
    source: sourceType === "local" ? source : undefined,
    enabledPlugins: [...enabled].filter(([, isEnabled]) => isEnabled).map(([name]) => name),
  };
}

export const resolveCodexDesktopPluginSkillRoots = Effect.fn("resolveCodexDesktopPluginSkillRoots")(
  function* (environment: NodeJS.ProcessEnv) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome = environment.CODEX_HOME ?? path.join(expandHomePath("~"), ".codex");
    const configPath = path.join(codexHome, "config.toml");
    const configText = yield* fs
      .readFileString(configPath)
      .pipe(
        Effect.mapError(
          () => new DesktopPluginSkillError({ reason: "Codex config.toml could not be read" }),
        ),
      );
    const config = yield* Effect.try({
      try: () => parseCodexDesktopPluginConfig(configText),
      catch: (cause) =>
        new DesktopPluginSkillError({
          reason:
            cause instanceof Error ? cause.message : "invalid bundled marketplace config.toml",
        }),
    });
    if (!config.source) return [];
    if (!path.isAbsolute(config.source)) {
      return yield* new DesktopPluginSkillError({
        reason: "bundled marketplace source is not an absolute path",
      });
    }

    const roots: string[] = [];
    for (const name of config.enabledPlugins) {
      const root = path.join(config.source, "plugins", name, "skills");
      const isDirectory = yield* fs.stat(root).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (isDirectory) roots.push(root);
    }
    return roots;
  },
);

/** A missing or rejected skill root must not prevent the daemon thread from opening. */
export const attachCodexDesktopPluginSkills = Effect.fn("attachCodexDesktopPluginSkills")(
  function* (
    client: {
      readonly raw: {
        readonly request: (
          method: "skills/extraRoots/set",
          params: { readonly extraRoots: ReadonlyArray<string> },
        ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
      };
    },
    environment: NodeJS.ProcessEnv,
  ) {
    return yield* Effect.gen(function* () {
      const extraRoots = yield* resolveCodexDesktopPluginSkillRoots(environment);
      if (extraRoots.length > 0) {
        yield* client.raw.request("skills/extraRoots/set", { extraRoots }).pipe(
          Effect.mapError(
            () =>
              new DesktopPluginSkillError({
                reason: "skills/extraRoots/set was rejected by the daemon",
              }),
          ),
        );
      }
      return undefined as string | undefined;
    }).pipe(
      Effect.catch((error) => {
        const warning = `desktop plugin skills could not be attached: ${error instanceof DesktopPluginSkillError ? error.reason : "skill directory lookup failed"}`;
        return Effect.logWarning(warning).pipe(Effect.as(warning));
      }),
    );
  },
);
