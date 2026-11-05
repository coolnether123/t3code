#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone operator staging boundary, never live userdata.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { stageRuntimeExternals } from "./build-cli-archive.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

class BackendStageError extends Schema.TaggedError<BackendStageError>()("BackendStageError", {
  message: Schema.String,
}) {}

export interface BackendStageOptions {
  readonly sourceRoot: string;
  readonly output: string;
  readonly commit: string;
  readonly arch: "arm64" | "x64";
}

export function assertBackendStagePaths(options: BackendStageOptions): void {
  if (!/^[0-9a-f]{40}$/u.test(options.commit))
    throw new BackendStageError({ message: "An exact lowercase source commit is required." });
  for (const path of [options.sourceRoot, options.output]) {
    if (!NodePath.isAbsolute(path) || NodePath.resolve(path) !== path || path === "/")
      throw new BackendStageError({
        message: "Use explicit normalized absolute source/output paths.",
      });
  }
  if (options.output === options.sourceRoot || options.output.startsWith(`${options.sourceRoot}/`))
    throw new BackendStageError({
      message: "Backend staging must be outside the source checkout.",
    });
  if (
    options.output.endsWith("/.t3") ||
    options.output.includes("/.t3/") ||
    options.output.startsWith("/Applications/")
  )
    throw new BackendStageError({ message: "Never stage inside a live T3 home or Applications." });
}

const stageDependencies = async (options: BackendStageOptions, version: string) =>
  Effect.runPromise(
    stageRuntimeExternals({
      repoRoot: options.sourceRoot,
      stageDir: options.output,
      platform: "mac",
      arch: options.arch,
      version,
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

export async function stageMacosBackend(
  options: BackendStageOptions,
  operations: {
    readonly stageDependencies: typeof stageDependencies;
    readonly host?: () => { platform: string; arch: string; node: string };
  } = { stageDependencies },
): Promise<void> {
  assertBackendStagePaths(options);
  options = {
    ...options,
    sourceRoot: await NodeFSP.realpath(options.sourceRoot),
    output: NodePath.join(
      await NodeFSP.realpath(NodePath.dirname(options.output)),
      NodePath.basename(options.output),
    ),
  };
  assertBackendStagePaths(options);
  const git = async (args: string[]) =>
    (
      await execFile("git", ["-C", options.sourceRoot, ...args], { maxBuffer: 16 * 1024 * 1024 })
    ).stdout.trim();
  const verifySource = async () => {
    if (
      (await git(["rev-parse", "HEAD"])) !== options.commit ||
      (await git(["status", "--porcelain", "--untracked-files=normal"])) !== ""
    )
      throw new BackendStageError({ message: "Source must be clean and match the pinned commit." });
  };
  await verifySource();
  // Match the target backend's Node version, not Electron's native-addon ABI.
  const host = operations.host?.() ?? {
    platform: Effect.runSync(HostProcess.Platform),
    arch: Effect.runSync(HostProcess.Architecture),
    node: process.versions.node,
  };
  if (host.platform !== "darwin" || host.arch !== options.arch || host.node !== "24.18.0")
    throw new BackendStageError({
      message: "Stage on matching macOS architecture with Node 24.18.0.",
    });
  await NodeFSP.mkdir(options.output, { recursive: false, mode: 0o700 });
  const manifest: { version: string } = JSON.parse(
    await NodeFSP.readFile(NodePath.join(options.sourceRoot, "apps/server/package.json"), "utf8"),
  );
  await operations.stageDependencies(options, manifest.version);
  for (const relative of ["dist/bin.mjs", "dist/client/index.html"]) {
    if (!(await NodeFSP.stat(NodePath.join(options.sourceRoot, "apps/server", relative))).isFile())
      throw new BackendStageError({ message: `Build the server/web bundles first: ${relative}` });
  }
  await NodeFSP.cp(
    NodePath.join(options.sourceRoot, "apps/server/dist"),
    NodePath.join(options.output, "dist"),
    { recursive: true, errorOnExist: true, force: false },
  );
  await verifySource();
  await NodeFSP.writeFile(
    NodePath.join(options.output, ".t3-source-commit"),
    `${options.commit}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Staged pinned Node backend at ${options.output}. Run the guarded backend deployer's dry run next.`,
  );
}

if (import.meta.main) {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined)
      throw new BackendStageError({
        message: "Use --source-root --output --commit --arch, each with a value.",
      });
    args.set(argv[i]!, argv[i + 1]!);
  }
  const arch = args.get("--arch");
  if (args.size !== 4 || (arch !== "arm64" && arch !== "x64"))
    throw new BackendStageError({
      message: "Use --source-root --output --commit --arch arm64|x64.",
    });
  await stageMacosBackend({
    sourceRoot: args.get("--source-root") ?? "",
    output: args.get("--output") ?? "",
    commit: args.get("--commit") ?? "",
    arch,
  });
}
