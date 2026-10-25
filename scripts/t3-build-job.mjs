import * as NodeChildProcess from "node:child_process";

// The shared checkout can lag the running gateway. Submit through its supported
// tool and execute the returned waiter, rather than importing an old queue adapter.
function runBuildJob(definition) {
  const invoke = (command, args) => {
    const child = NodeChildProcess.spawnSync(command, args, {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!child.stdout?.trim())
      throw new Error(`Build queue command returned no receipt, exit ${child.status}`);
    return JSON.parse(child.stdout);
  };
  const job = invoke(process.execPath, [
    "A:/Dev/Projects/Otis/tools/otis-call/otis-call.mjs",
    "call",
    "submit_build_job",
    `@${definition}`,
  ]);
  if (!job.jobId || !Array.isArray(job.waiter?.argv))
    throw new Error("Build queue did not supply a native foreground waiter");
  const [command, ...args] = job.waiter.argv;
  while (true) {
    const result = invoke(command, args);
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(result.status)) return result;
    if (!["still-running", "queued", "running", "blocked"].includes(result.status))
      throw new Error("Build waiter returned an unknown state");
  }
}
if (process.argv[1] === import.meta.filename) {
  const receipt = runBuildJob(process.argv[2]);
  console.log(JSON.stringify(receipt));
  process.exitCode = receipt.status === "succeeded" && receipt.exitCode === 0 ? 0 : 1;
}
