import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as NodeURL from "node:url";
import { ChildProcessSpawner } from "effect/unstable/process";

import { referenceRepos } from "./lib/reference-repos.ts";
import {
  planReferenceRepoSync,
  resolveReferenceRepoRef,
  syncReferenceRepos,
} from "./sync-reference-repos.ts";

const encoder = new TextEncoder();
const effectSmol = referenceRepos[0]!;
const alchemyEffect = referenceRepos[1]!;
const decodeWorktreeSetup = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      scripts: Schema.Array(
        Schema.Struct({ command: Schema.String, runOnWorktreeCreate: Schema.Boolean }),
      ),
    }),
  ),
);

function mockHandle(
  options: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  } = {},
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(options.stdout ?? "done\n")),
    stderr: Stream.make(encoder.encode(options.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  handle:
    | ReturnType<typeof mockHandle>
    | ((args: ReadonlyArray<string>) => ReturnType<typeof mockHandle>) = mockHandle(),
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(typeof handle === "function" ? handle(childProcess.args) : handle);
    }),
  );
}

const guidanceFixture = Effect.fn("guidanceFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootDir = yield* fs.makeTempDirectoryScoped({ prefix: "reference-guidance-test-" });
  yield* fs.writeFileString(
    path.join(rootDir, "pnpm-workspace.yaml"),
    "catalog:\n  effect: 4.0.0-beta.73\n",
  );
  const destination = path.join(rootDir, effectSmol.prefix, "LLMS.md");
  yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
  // Windows will not remove read-only files when the scoped temporary directory closes.
  yield* Effect.addFinalizer(() => fs.chmod(destination, 0o644).pipe(Effect.ignore));
  return { fs, path, rootDir, destination };
});

it.layer(NodeServices.layer)("sync-reference-repos", (it) => {
  it.effect("restores pinned read-only guidance without a subtree operation", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { fs, rootDir, destination } = yield* guidanceFixture();
      const plans = yield* syncReferenceRepos({
        rootDir,
        repoId: effectSmol.id,
        guidanceOnly: true,
      }).pipe(
        Effect.provide(
          mockSpawnerLayer(commands, mockHandle({ stdout: "# Synthetic guidance\n" })),
        ),
      );
      assert.equal(plans[0]?.ref, "effect@4.0.0-beta.73");
      assert.deepStrictEqual(
        commands.map((command) => command.args),
        [
          ["init", "--bare"],
          [
            "fetch",
            "--depth=1",
            "--no-tags",
            effectSmol.repository,
            "refs/tags/effect@4.0.0-beta.73",
          ],
          ["show", "FETCH_HEAD:LLMS.md"],
        ],
      );
      assert.equal(yield* fs.readFileString(destination), "# Synthetic guidance\n");
      assert.equal((yield* fs.stat(destination)).mode & 0o222, 0);
    });
  });

  it.effect("leaves an existing matching guide intact on repeated setup", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { fs, rootDir, destination } = yield* guidanceFixture();
      const setup = syncReferenceRepos({ rootDir, guidanceOnly: true }).pipe(
        Effect.provide(mockSpawnerLayer(commands)),
      );
      yield* setup;
      const before = (yield* fs.stat(destination)).mtime;
      yield* setup;
      assert.equal(yield* fs.readFileString(destination), "done\n");
      assert.deepStrictEqual((yield* fs.stat(destination)).mtime, before);
      assert.equal(commands.length, 6);
    });
  });

  it.effect("does not overwrite existing guidance that differs from the pin", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { fs, path, rootDir, destination } = yield* guidanceFixture();
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.writeFileString(destination, "# Existing synthetic document\n");
      const error = yield* syncReferenceRepos({ rootDir, guidanceOnly: true }).pipe(
        Effect.provide(mockSpawnerLayer(commands)),
        Effect.flip,
      );
      assert.equal(error._tag, "ReferenceRepoGuidanceError");
      assert.equal(yield* fs.readFileString(destination), "# Existing synthetic document\n");
    });
  });

  it.effect("guidance dry-run neither fetches nor writes documents", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { fs, rootDir, destination } = yield* guidanceFixture();
      const plans = yield* syncReferenceRepos({ rootDir, guidanceOnly: true, dryRun: true }).pipe(
        Effect.provide(mockSpawnerLayer(commands)),
      );
      assert.equal(plans.length, 1);
      assert.equal(plans[0]?.action, "guidance");
      assert.deepStrictEqual(commands, []);
      assert.equal(yield* fs.exists(destination), false);
    });
  });

  it.effect("rejects unpinned guidance before fetching or writing", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { fs, rootDir, destination } = yield* guidanceFixture();
      const error = yield* syncReferenceRepos({ rootDir, guidanceOnly: true, latest: true }).pipe(
        Effect.provide(mockSpawnerLayer(commands)),
        Effect.flip,
      );
      assert.equal(error._tag, "ReferenceRepoGuidanceError");
      assert.deepStrictEqual(commands, []);
      assert.equal(yield* fs.exists(destination), false);
    });
  });

  it.effect("failed Git guidance setup leaves no document", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { fs, rootDir, destination } = yield* guidanceFixture();
      const error = yield* syncReferenceRepos({ rootDir, guidanceOnly: true }).pipe(
        Effect.provide(
          mockSpawnerLayer(commands, (args) =>
            mockHandle({ exitCode: args[0] === "show" ? 1 : 0 }),
          ),
        ),
        Effect.flip,
      );
      assert.equal(error._tag, "ReferenceRepoGitSubtreeError");
      assert.equal(commands.length, 3);
      assert.equal(yield* fs.exists(destination), false);
    });
  });

  it.effect("rejects an empty pinned document without creating guidance", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { fs, rootDir, destination } = yield* guidanceFixture();
      const error = yield* syncReferenceRepos({ rootDir, guidanceOnly: true }).pipe(
        Effect.provide(mockSpawnerLayer(commands, mockHandle({ stdout: "" }))),
        Effect.flip,
      );
      assert.equal(error._tag, "ReferenceRepoGuidanceError");
      assert.equal(yield* fs.exists(destination), false);
    });
  });

  it.effect("does not fabricate a vendor subtree when reference source is missing", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { fs, path, rootDir, destination } = yield* guidanceFixture();
      yield* fs.rename(path.dirname(destination), path.join(rootDir, "synthetic-reference-source"));
      const error = yield* syncReferenceRepos({ rootDir, guidanceOnly: true }).pipe(
        Effect.provide(mockSpawnerLayer(commands)),
        Effect.flip,
      );
      assert.equal(error._tag, "ReferenceRepoGuidanceError");
      assert.deepStrictEqual(commands, []);
      assert.equal(yield* fs.exists(destination), false);
    });
  });

  it.effect("rejects a reference directory resolved outside the worktree before fetching", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { fs, path, rootDir, destination } = yield* guidanceFixture();
      const redirectedPaths = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        realPath: () => Effect.succeed(path.join(rootDir, "synthetic-external-reference")),
      });
      const error = yield* syncReferenceRepos({ rootDir, guidanceOnly: true }).pipe(
        Effect.provide(Layer.merge(redirectedPaths, mockSpawnerLayer(commands))),
        Effect.flip,
      );
      assert.equal(error._tag, "ReferenceRepoGuidanceError");
      assert.deepStrictEqual(commands, []);
      assert.equal(yield* fs.exists(destination), false);
    });
  });

  it.effect("leaves redirected existing guidance content and permissions unchanged", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      const { fs, path, rootDir, destination } = yield* guidanceFixture();
      yield* fs.writeFileString(destination, "done\n");
      const before = (yield* fs.stat(destination)).mode;
      const redirectedPaths = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        realPath: (value) =>
          value === destination
            ? Effect.succeed(path.join(rootDir, "synthetic-external-document"))
            : fs.realPath(value),
      });
      const error = yield* syncReferenceRepos({ rootDir, guidanceOnly: true }).pipe(
        Effect.provide(Layer.merge(redirectedPaths, mockSpawnerLayer(commands))),
        Effect.flip,
      );
      assert.equal(error._tag, "ReferenceRepoGuidanceError");
      assert.equal(yield* fs.readFileString(destination), "done\n");
      assert.equal((yield* fs.stat(destination)).mode, before);
    });
  });

  it.effect("both worktree setup commands restore guidance before optional environment links", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* decodeWorktreeSetup(
        yield* fs.readFileString(NodeURL.fileURLToPath(new URL("../t3.json", import.meta.url))),
      );
      assert.equal(config.scripts.length, 2);
      for (const script of config.scripts) {
        assert.ok(script.runOnWorktreeCreate);
        assert.ok(
          script.command.startsWith(
            "vp i && node scripts/sync-reference-repos.ts --repo effect-smol --guidance-only && ",
          ),
        );
      }
    }),
  );

  it.effect("resolves the effect-smol tag from the root catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-version-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      assert.equal(
        yield* resolveReferenceRepoRef(effectSmol, rootDir, false),
        "effect@4.0.0-beta.73",
      );
    }),
  );

  it.effect("uses the latest branch without reading package versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-latest-",
      });

      assert.equal(yield* resolveReferenceRepoRef(effectSmol, rootDir, true), "main");
    }),
  );

  it.effect("preserves version source read context and the filesystem cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-read-error-",
      });
      const sourcePath = path.join(rootDir, effectSmol.versionSourcePath);

      const error = yield* resolveReferenceRepoRef(effectSmol, rootDir, false).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoVersionSourceError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "read");
      assert.equal(error.repoId, effectSmol.id);
      assert.equal(error.sourcePath, sourcePath);
      assert.ok(error.cause !== undefined);
      assert.ok(!error.message.includes(String((error.cause as Error).message)));
    }),
  );

  it.effect("preserves version source parse context and the schema cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-parse-error-",
      });
      const sourcePath = path.join(rootDir, alchemyEffect.versionSourcePath);
      yield* fs.makeDirectory(path.dirname(sourcePath), { recursive: true });
      yield* fs.writeFileString(sourcePath, "{");

      const error = yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoVersionSourceError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "parse");
      assert.equal(error.repoId, alchemyEffect.id);
      assert.equal(error.sourcePath, sourcePath);
      assert.ok(error.cause !== undefined);
      assert.ok(!error.message.includes(String((error.cause as Error).message)));
    }),
  );

  it.effect("reports the unresolved package path without inventing a cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-resolution-error-",
      });
      const sourcePath = path.join(rootDir, alchemyEffect.versionSourcePath);
      yield* fs.makeDirectory(path.dirname(sourcePath), { recursive: true });
      yield* fs.writeFileString(sourcePath, '{"dependencies":{}}');

      const error = yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoVersionResolutionError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.repoId, alchemyEffect.id);
      assert.equal(error.sourcePath, sourcePath);
      assert.deepStrictEqual(error.packageVersionPath, ["dependencies", "alchemy"]);
      assert.ok(!("cause" in error));
    }),
  );

  it.effect("resolves the alchemy-effect tag from the relay package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-alchemy-version-",
      });
      yield* fs.makeDirectory(path.join(rootDir, "infra", "relay"), { recursive: true });
      yield* fs.writeFileString(
        path.join(rootDir, "infra", "relay", "package.json"),
        '{"dependencies":{"alchemy":"2.0.0-beta.49"}}',
      );

      assert.equal(yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false), "v2.0.0-beta.49");
    }),
  );

  it.effect("plans an add for a missing subtree and a pull for an existing subtree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-plan-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const addPlan = yield* planReferenceRepoSync(effectSmol, rootDir, false);
      assert.equal(addPlan.action, "add");
      assert.deepStrictEqual(addPlan.args, [
        "subtree",
        "add",
        "--prefix=.repos/effect-smol",
        "https://github.com/Effect-TS/effect.git",
        "effect@4.0.0-beta.73",
        "--squash",
      ]);

      yield* fs.makeDirectory(path.join(rootDir, effectSmol.prefix), { recursive: true });
      assert.equal((yield* planReferenceRepoSync(effectSmol, rootDir, false)).action, "pull");
    }),
  );

  it.effect("runs the planned git subtree command through the process service", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-run-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      yield* syncReferenceRepos({ rootDir, repoId: "effect-smol" }).pipe(
        Effect.provide(mockSpawnerLayer(commands)),
      );

      assert.deepStrictEqual(commands, [
        {
          command: "git",
          args: [
            "subtree",
            "add",
            "--prefix=.repos/effect-smol",
            "https://github.com/Effect-TS/effect.git",
            "effect@4.0.0-beta.73",
            "--squash",
          ],
        },
      ]);
    });
  });

  it.effect("rejects unknown repo selectors", () =>
    Effect.gen(function* () {
      const error = yield* syncReferenceRepos({
        repoId: "missing",
        dryRun: true,
      }).pipe(Effect.flip);

      if (error._tag !== "ReferenceRepoSelectionError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.repoId, "missing");
      assert.deepStrictEqual(error.expectedRepoIds, ["effect-smol", "alchemy-effect"]);
      assert.ok(!("cause" in error));
    }),
  );

  it.effect("reports non-zero git exits without retaining process output", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-exit-error-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const error = yield* syncReferenceRepos({ rootDir, repoId: "effect-smol" }).pipe(
        Effect.provide(
          mockSpawnerLayer(
            commands,
            mockHandle({ exitCode: 23, stderr: "subtree failed secret-token-value\n" }),
          ),
        ),
        Effect.flip,
      );

      if (error._tag !== "ReferenceRepoGitSubtreeError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "exit");
      assert.equal(error.repoId, effectSmol.id);
      assert.equal(error.action, "add");
      assert.equal(error.repository, effectSmol.repository);
      assert.equal(error.ref, "effect@4.0.0-beta.73");
      assert.equal(error.rootDir, rootDir);
      assert.equal(error.argumentCount, commands[0]?.args.length);
      assert.equal(error.exitCode, 23);
      assert.equal(error.stdoutLength, 5);
      assert.equal(error.stderrLength, 34);
      assert.notProperty(error, "args");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "secret-token-value");
      assert.ok(!("cause" in error));
    });
  });
});
