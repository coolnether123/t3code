#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import { referenceRepos, type ReferenceRepo } from "./lib/reference-repos.ts";

export type ReferenceRepoSyncAction = "add" | "pull" | "guidance";

export interface ReferenceRepoSyncOptions {
  readonly rootDir?: string | undefined;
  readonly repoId?: string | undefined;
  readonly latest?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly guidanceOnly?: boolean | undefined;
}

export interface ReferenceRepoSyncPlan {
  readonly repo: ReferenceRepo;
  readonly action: ReferenceRepoSyncAction;
  readonly ref: string;
  readonly args: ReadonlyArray<string>;
}

export class ReferenceRepoSelectionError extends Schema.TaggedErrorClass<ReferenceRepoSelectionError>()(
  "ReferenceRepoSelectionError",
  {
    repoId: Schema.String,
    expectedRepoIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Unknown reference repo "${this.repoId}". Expected one of: ${this.expectedRepoIds.join(", ")}.`;
  }
}

export class ReferenceRepoVersionSourceError extends Schema.TaggedErrorClass<ReferenceRepoVersionSourceError>()(
  "ReferenceRepoVersionSourceError",
  {
    operation: Schema.Literals(["read", "parse"]),
    repoId: Schema.String,
    sourcePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Reference repo "${this.repoId}" version source operation "${this.operation}" failed for ${this.sourcePath}.`;
  }
}

export class ReferenceRepoVersionResolutionError extends Schema.TaggedErrorClass<ReferenceRepoVersionResolutionError>()(
  "ReferenceRepoVersionResolutionError",
  {
    repoId: Schema.String,
    sourcePath: Schema.String,
    packageVersionPath: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No version was found for reference repo "${this.repoId}" at ${this.sourcePath}:${this.packageVersionPath.join(".")}.`;
  }
}

export class ReferenceRepoGitSubtreeError extends Schema.TaggedErrorClass<ReferenceRepoGitSubtreeError>()(
  "ReferenceRepoGitSubtreeError",
  {
    operation: Schema.Literals(["spawn", "communicate", "exit"]),
    repoId: Schema.String,
    action: Schema.Literals(["add", "pull", "guidance"]),
    repository: Schema.String,
    ref: Schema.String,
    rootDir: Schema.String,
    argumentCount: Schema.Number,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Git reference ${this.action} for repo "${this.repoId}" failed during "${this.operation}".`;
  }
}

export class ReferenceRepoGuidanceError extends Schema.TaggedErrorClass<ReferenceRepoGuidanceError>()(
  "ReferenceRepoGuidanceError",
  { repoId: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Guidance setup for reference repo "${this.repoId}" failed: ${this.reason}.`;
  }
}

export const ReferenceRepoSyncError = Schema.Union([
  ReferenceRepoSelectionError,
  ReferenceRepoVersionSourceError,
  ReferenceRepoVersionResolutionError,
  ReferenceRepoGitSubtreeError,
  ReferenceRepoGuidanceError,
]);
export type ReferenceRepoSyncError = typeof ReferenceRepoSyncError.Type;
export const isReferenceRepoSyncError = Schema.is(ReferenceRepoSyncError);

const decodeJsonSource = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeYamlSource = Schema.decodeEffect(fromYaml(Schema.Unknown));

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

function readNestedString(input: unknown, keys: ReadonlyArray<string>): string | undefined {
  let value = input;
  for (const key of keys) {
    if (typeof value !== "object" || value === null || !(key in value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeVersionSource(
  repo: ReferenceRepo,
  sourcePath: string,
  content: string,
): Effect.Effect<unknown, ReferenceRepoSyncError> {
  const decode =
    repo.versionSourcePath.endsWith(".yaml") || repo.versionSourcePath.endsWith(".yml")
      ? decodeYamlSource
      : decodeJsonSource;
  return decode(content).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoVersionSourceError({
          operation: "parse",
          repoId: repo.id,
          sourcePath,
          cause,
        }),
    ),
  );
}

function getSelectedRepos(
  repoId: string | undefined,
): Effect.Effect<ReadonlyArray<ReferenceRepo>, ReferenceRepoSyncError> {
  if (!repoId) {
    return Effect.succeed(referenceRepos);
  }

  const repo = referenceRepos.find((candidate) => candidate.id === repoId);
  return repo
    ? Effect.succeed([repo])
    : Effect.fail(
        new ReferenceRepoSelectionError({
          repoId,
          expectedRepoIds: referenceRepos.map((candidate) => candidate.id),
        }),
      );
}

export const resolveReferenceRepoRef = Effect.fn("resolveReferenceRepoRef")(function* (
  repo: ReferenceRepo,
  rootDir: string,
  latest: boolean,
) {
  if (latest) {
    return repo.latestRef;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versionSourcePath = path.join(rootDir, repo.versionSourcePath);
  const versionSourceContent = yield* fs.readFileString(versionSourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoVersionSourceError({
          operation: "read",
          repoId: repo.id,
          sourcePath: versionSourcePath,
          cause,
        }),
    ),
  );
  const versionSource = yield* decodeVersionSource(repo, versionSourcePath, versionSourceContent);
  const version = readNestedString(versionSource, repo.packageVersionPath);

  if (!version) {
    return yield* new ReferenceRepoVersionResolutionError({
      repoId: repo.id,
      sourcePath: versionSourcePath,
      packageVersionPath: repo.packageVersionPath,
    });
  }

  return `${repo.versionTagPrefix}${version}`;
});

export const planReferenceRepoSync = Effect.fn("planReferenceRepoSync")(function* (
  repo: ReferenceRepo,
  rootDir: string,
  latest: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const action: ReferenceRepoSyncAction = (yield* fs.exists(path.join(rootDir, repo.prefix)))
    ? "pull"
    : "add";
  const ref = yield* resolveReferenceRepoRef(repo, rootDir, latest);

  return {
    repo,
    action,
    ref,
    args: ["subtree", action, `--prefix=${repo.prefix}`, repo.repository, ref, "--squash"],
  } satisfies ReferenceRepoSyncPlan;
});

const runGit = Effect.fn("runGit")(function* (rootDir: string, plan: ReferenceRepoSyncPlan) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const errorContext = {
    repoId: plan.repo.id,
    action: plan.action,
    repository: plan.repo.repository,
    ref: plan.ref,
    rootDir,
    argumentCount: plan.args.length,
  } as const;
  const child = yield* spawner.spawn(ChildProcess.make("git", plan.args, { cwd: rootDir })).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoGitSubtreeError({
          ...errorContext,
          operation: "spawn",
          cause,
        }),
    ),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoGitSubtreeError({
          ...errorContext,
          operation: "communicate",
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    return yield* new ReferenceRepoGitSubtreeError({
      ...errorContext,
      operation: "exit",
      exitCode,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    });
  }

  if (plan.action !== "guidance" && stdout.trim().length > 0) {
    yield* Console.log(stdout.trim());
  }
  return stdout;
});

// Fetch into a disposable repository so setup never changes the worktree's refs or subtree.
const restoreReferenceRepoGuidance = Effect.fn("restoreReferenceRepoGuidance")(function* (
  rootDir: string,
  plan: ReferenceRepoSyncPlan,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prefix = path.join(rootDir, plan.repo.prefix);
  if (!(yield* fs.exists(prefix))) {
    return yield* new ReferenceRepoGuidanceError({
      repoId: plan.repo.id,
      reason: "reference source is missing",
    });
  }
  if (path.relative(prefix, yield* fs.realPath(prefix)) !== "") {
    return yield* new ReferenceRepoGuidanceError({
      repoId: plan.repo.id,
      reason: "reference source must be worktree-local",
    });
  }
  const temporaryRepo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reference-guidance-" });
  const git = (args: ReadonlyArray<string>) => runGit(temporaryRepo, { ...plan, args });
  yield* git(["init", "--bare"]);
  yield* git(["fetch", "--depth=1", "--no-tags", plan.repo.repository, `refs/tags/${plan.ref}`]);
  for (const file of plan.repo.guidanceFiles ?? []) {
    const content = yield* git(["show", `FETCH_HEAD:${file}`]);
    if (content.trim().length === 0) {
      return yield* new ReferenceRepoGuidanceError({
        repoId: plan.repo.id,
        reason: "empty document",
      });
    }
    const destination = path.join(rootDir, plan.repo.prefix, file);
    if (yield* fs.exists(destination)) {
      if (path.relative(destination, yield* fs.realPath(destination)) !== "") {
        return yield* new ReferenceRepoGuidanceError({
          repoId: plan.repo.id,
          reason: "guidance must be worktree-local",
        });
      }
      if ((yield* fs.readFileString(destination)) !== content) {
        return yield* new ReferenceRepoGuidanceError({
          repoId: plan.repo.id,
          reason: `existing ${file} differs from ${plan.ref}; left unchanged`,
        });
      }
    } else {
      yield* fs.writeFileString(destination, content, { flag: "wx", mode: 0o444 });
    }
    yield* fs.chmod(destination, 0o444);
  }
}, Effect.scoped);

export const syncReferenceRepos = Effect.fn("syncReferenceRepos")(function* (
  options: ReferenceRepoSyncOptions = {},
) {
  const path = yield* Path.Path;
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const repos = yield* getSelectedRepos(options.repoId);
  const plans: Array<ReferenceRepoSyncPlan> = [];

  for (const repo of repos) {
    if (options.guidanceOnly) {
      if (options.latest) {
        return yield* new ReferenceRepoGuidanceError({
          repoId: repo.id,
          reason: "guidance requires the pinned version, not --latest",
        });
      }
      if (!repo.guidanceFiles?.length) continue;
      const ref = yield* resolveReferenceRepoRef(repo, rootDir, false);
      const plan = { repo, action: "guidance", ref, args: [] } satisfies ReferenceRepoSyncPlan;
      plans.push(plan);
      yield* Console.log(`Restoring read-only guidance for ${repo.id} from ${ref}.`);
      if (!options.dryRun) yield* restoreReferenceRepoGuidance(rootDir, plan);
      continue;
    }
    const plan = yield* planReferenceRepoSync(repo, rootDir, options.latest ?? false);
    plans.push(plan);
    yield* Console.log(`Syncing ${repo.id} from ${plan.ref} with git subtree ${plan.action}.`);
    if (!(options.dryRun ?? false)) {
      yield* runGit(rootDir, plan).pipe(Effect.scoped);
    }
  }

  return plans;
});

export const syncReferenceReposCommand = Command.make(
  "sync-reference-repos",
  {
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Sync only the named reference repo. Defaults to all configured repos."),
      Flag.optional,
    ),
    latest: Flag.boolean("latest").pipe(
      Flag.withDescription(
        "Sync each repo from its latest branch instead of the installed version.",
      ),
      Flag.withDefault(false),
    ),
    root: Flag.string("root").pipe(
      Flag.withDescription("Workspace root used to resolve versions and subtree prefixes."),
      Flag.optional,
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Print planned subtree operations without running git."),
      Flag.withDefault(false),
    ),
    guidanceOnly: Flag.boolean("guidance-only").pipe(
      Flag.withDescription(
        "Restore pinned read-only guidance without changing Git history or vendor source.",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ repo, latest, root, dryRun, guidanceOnly }) =>
    syncReferenceRepos({
      repoId: Option.getOrUndefined(repo),
      rootDir: Option.getOrUndefined(root),
      latest,
      dryRun,
      guidanceOnly,
    }),
).pipe(Command.withDescription("Sync vendored reference repositories under .repos/."));

if (import.meta.main) {
  Command.run(syncReferenceReposCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
