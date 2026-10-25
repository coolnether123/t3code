import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

// A scheduled task has no chat identity. The installed local queue client is
// the supported deterministic route, and follows the gateway's active version.
function runBuildJob(definition, submitOnly) {
  let releaseDir;
  try {
    ({ releaseDir } = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(
          process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData/Local"),
          "Otis/gateway/active.json",
        ),
        "utf8",
      ),
    ));
    if (typeof releaseDir !== "string" || !NodePath.isAbsolute(releaseDir)) throw new Error();
  } catch {
    throw new Error("Cannot resolve the installed build queue");
  }
  const runner = NodePath.join(releaseDir, "native/build-runner/JobRunner.dll");
  const environment = { ...process.env, OTIS_RUNNER_DLL: runner, OTIS_BUILD_WAITER_DLL: runner };
  const invoke = (command, args) => {
    const child = NodeChildProcess.spawnSync(command, args, {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: environment,
    });
    if (!child.stdout?.trim())
      throw new Error(`Build queue command returned no receipt, exit ${child.status}`);
    return JSON.parse(child.stdout);
  };
  const job = invoke(process.execPath, [
    NodePath.join(releaseDir, "tools/resource/build-queue.mjs"),
    "submit",
    definition,
  ]);
  if (!job.jobId || !Array.isArray(job.waiter?.argv))
    throw new Error("Build queue did not supply a native foreground waiter");
  if (submitOnly) return job;
  const [command, ...args] = job.waiter.argv;
  while (true) {
    const result = invoke(command, args);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(result.status)) return result;
    if (!["still-running", "queued", "running", "blocked"].includes(result.status))
      throw new Error("Build waiter returned an unknown state");
  }
}
if (process.argv[1] === import.meta.filename) {
  const submitOnly = process.argv.includes("--submit-only");
  const receipt = runBuildJob(process.argv[2], submitOnly);
  console.log(JSON.stringify(receipt));
  process.exitCode =
    submitOnly || (receipt.status === "succeeded" && receipt.exitCode === 0) ? 0 : 1;
}
