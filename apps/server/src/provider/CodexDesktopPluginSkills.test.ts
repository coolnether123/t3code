import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as CodexErrors from "effect-codex-app-server/errors";
import { describe } from "vite-plus/test";

import {
  attachCodexDesktopPluginSkills,
  parseCodexDesktopPluginConfig,
  resolveCodexDesktopPluginSkillRoots,
} from "./CodexDesktopPluginSkills.ts";

const bundleSource = NodePath.resolve("/bundle").replaceAll("\\", "/");
const chromeSkillsRoot = NodePath.join(bundleSource, "plugins", "chrome", "skills");
const codexHome = NodePath.resolve("/fake-codex-home");
const config = `
[marketplaces.openai-bundled]
source_type = "local"
source = '${bundleSource}'

[plugins."chrome@openai-bundled"]
enabled = true
[plugins."browser@openai-bundled"]
enabled = false
[plugins."computer-use@openai-bundled"]
enabled = true
[plugins."other@somewhere-else"]
enabled = true
`;

const withConfig = <A, E, R>(
  source: string,
  existing: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reads: string[] = [];
    const checked: string[] = [];
    const result = yield* effect.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (file) => {
          reads.push(file);
          return Effect.succeed(source);
        },
        stat: (file) => {
          checked.push(file);
          return Effect.succeed({
            type: existing.includes(file) ? "Directory" : "File",
          }) as unknown as ReturnType<typeof fs.stat>;
        },
      }),
    );
    return { result, reads, checked, path };
  }).pipe(Effect.provide(NodeServices.layer));

describe("Codex desktop plugin skill roots", () => {
  it("reads only enabled bundled plugins from the local marketplace", () => {
    NodeAssert.deepStrictEqual(parseCodexDesktopPluginConfig(config), {
      source: bundleSource,
      enabledPlugins: ["chrome", "computer-use"],
    });
    NodeAssert.deepStrictEqual(
      parseCodexDesktopPluginConfig(`
[marketplaces.openai-bundled]
source_type = 'remote'
source = '/unused'
[plugins."chrome@openai-bundled"]
enabled = true
`),
      { source: undefined, enabledPlugins: ["chrome"] },
    );
  });

  it.effect("skips missing skill directories and uses the daemon CODEX_HOME", () =>
    Effect.gen(function* () {
      const home = codexHome;
      const result = yield* withConfig(
        config,
        [chromeSkillsRoot],
        resolveCodexDesktopPluginSkillRoots({ CODEX_HOME: home }),
      );
      NodeAssert.deepStrictEqual(result.reads, [result.path.join(home, "config.toml")]);
      NodeAssert.deepStrictEqual(result.checked, [
        result.path.join(bundleSource, "plugins", "chrome", "skills"),
        result.path.join(bundleSource, "plugins", "computer-use", "skills"),
      ]);
      NodeAssert.deepStrictEqual(result.result, [result.checked[0]]);
    }),
  );

  it.effect("does not call the daemon when no enabled skill directory exists", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const { result } = yield* withConfig(
        config,
        [],
        attachCodexDesktopPluginSkills(
          {
            raw: {
              request: (method, params) => {
                calls.push({ method, params });
                return Effect.succeed({});
              },
            },
          },
          { CODEX_HOME: codexHome },
        ),
      );
      NodeAssert.deepStrictEqual(result, { extraRoots: [], warning: undefined });
      NodeAssert.deepStrictEqual(calls, []);
    }),
  );

  it.effect("returns roots only after the daemon accepts them", () =>
    Effect.gen(function* () {
      const root = chromeSkillsRoot;
      const { result } = yield* withConfig(
        config,
        [root],
        attachCodexDesktopPluginSkills(
          { raw: { request: () => Effect.succeed({}) } },
          { CODEX_HOME: codexHome },
        ),
      );
      NodeAssert.deepStrictEqual(result, { extraRoots: [root], warning: undefined });
    }),
  );

  it.effect("reports malformed config without sending roots", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const { result } = yield* withConfig(
        '[plugins."chrome@openai-bundled"]\nenabled = maybe',
        [],
        attachCodexDesktopPluginSkills(
          {
            raw: {
              request: (method, params) => {
                calls.push({ method, params });
                return Effect.succeed({});
              },
            },
          },
          { CODEX_HOME: codexHome },
        ),
      );
      NodeAssert.match(
        result.warning!,
        /desktop plugin skills could not be attached: invalid bundled plugin enabled value/,
      );
      NodeAssert.deepStrictEqual(calls, []);
    }),
  );

  it.effect("reports a rejected daemon skill-root request without failing startup", () =>
    Effect.gen(function* () {
      const { result } = yield* withConfig(
        config,
        [chromeSkillsRoot],
        attachCodexDesktopPluginSkills(
          {
            raw: {
              request: () =>
                Effect.fail(
                  new CodexErrors.CodexAppServerRequestError({
                    method: "skills/extraRoots/set",
                    code: -1,
                    errorMessage: "fake daemon rejection",
                  }),
                ),
            },
          },
          { CODEX_HOME: codexHome },
        ),
      );
      NodeAssert.equal(
        result.warning,
        "desktop plugin skills could not be attached: skills/extraRoots/set was rejected by the daemon",
      );
      NodeAssert.deepStrictEqual(result.extraRoots, []);
    }),
  );
});
