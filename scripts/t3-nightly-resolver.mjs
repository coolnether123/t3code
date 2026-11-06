import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";

function privateDirectory(directory) {
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = NodeFS.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw Error("The resolver ledger must be private and owner-held.");
}

function save(fd, value) {
  NodeFS.ftruncateSync(fd);
  NodeFS.writeSync(fd, JSON.stringify(value, null, 2), 0, "utf8");
  NodeFS.fsyncSync(fd);
}

function resolverPrompt({ config, base, upstream, conflicts }) {
  return `You are Christine's one-shot nightly merge resolver on Elora.
Read ${config.repository}/AGENTS.md and /Users/christinesmith/Codex_Workroom/AGENTS.md.
Your only writable project is ${config.repository}, branch ${config.branch}.
The nightly owns an uncommitted merge of upstream ${upstream} into base ${base}.
Resolve the conflicts below and any integration problems exposed by focused checks.
Preserve Christine's fork features: parent wake, gpt-6.1-sol medium defaults,
no costly model fallback, Mac features, guarded deployment and nightly sync.
Use apply_patch to edit tracked source. The controller will stage your edits,
run all gates and make the merge commit with exactly one trailer:
Otis-Task: agenda-task:751f84838c97405894f13c970a219c93
Do not commit, publish, deploy, install, stage, reset, abort or start another merge.
Do not change branches, fetch another upstream head, create worktrees, start agents,
weaken checks, change credentials/configuration, or bypass hooks.
No real chats, messages, Deck calls, speech, focus/mouse/AppleScript, app restarts,
process kills, live userdata writes, or changes outside this repository.
If a focused check is necessary, run only its relevant test, not repo-wide checks.
The configured focused test files are ${JSON.stringify(config.focusedTests ?? [])}.
Repair integration failures found by those checks during this same resolver run.
Do not wait for a chat, approval or user session. If repair is not safe, stop and
explain the remaining problem in your final response. There is no retry or fallback.
Conflicts: ${JSON.stringify(conflicts)}
`;
}

export async function launchResolver({ exe, args, prompt, directory, repository, env, onSpawn }) {
  const stdout = NodeFS.openSync(NodePath.join(directory, "resolver-stdout.jsonl"), "wx", 0o600);
  const stderr = NodeFS.openSync(NodePath.join(directory, "resolver-stderr.log"), "wx", 0o600);
  let child;
  let timer;
  let hardTimer;
  let timedOut = false;
  let recordingFailed = false;
  try {
    child = NodeChildProcess.spawn(exe, args, {
      cwd: repository,
      env,
      detached: true,
      stdio: ["pipe", stdout, stderr],
    });
    const signalOwnedGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* Failed cancellation keeps recovery held until group exit is proven. */
      }
    };
    const result = await new Promise((resolve) => {
      child.once("spawn", () => {
        try {
          onSpawn(child.pid);
        } catch {
          recordingFailed = true;
          signalOwnedGroup("SIGKILL");
          return;
        }
        timer = setTimeout(() => {
          timedOut = true;
          signalOwnedGroup("SIGTERM");
          hardTimer = setTimeout(() => signalOwnedGroup("SIGKILL"), 10000);
        }, 3_600_000);
      });
      child.once("error", () => resolve({ code: 1, safeToRecover: !child.pid }));
      child.once("close", (code) => {
        if (timedOut) signalOwnedGroup("SIGKILL");
        // A CLI exit is not proof its owned subprocess group has also exited.
        let safeToRecover = false;
        try {
          process.kill(-child.pid, 0);
        } catch (error) {
          safeToRecover = error.code === "ESRCH";
        }
        resolve({
          code: timedOut || recordingFailed ? 1 : (code ?? 1),
          safeToRecover,
          pid: child.pid,
          timedOut,
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
    return result;
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    NodeFS.closeSync(stdout);
    NodeFS.closeSync(stderr);
  }
}

export async function resolveNightlyConflict(input, io = {}) {
  const { config, directory, root, upstream, base, conflicts } = input;
  if (!/^[0-9a-f]{40}$/.test(upstream) || !/^[0-9a-f]{40}$/.test(base) || !conflicts?.length)
    throw Error("The resolver requires exact source identity and real conflicts.");
  if (
    !io.run &&
    // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone GUI launcher must reject non-macOS hosts before starting a resolver.
    (process.platform !== "darwin" ||
      NodeOS.hostname() !== "Elora.local" ||
      NodeOS.userInfo().username !== "christinesmith")
  )
    throw Error("The resolver only runs as Christine on Elora.");
  const ledgerRoot = NodePath.join(root, "resolver-heads");
  privateDirectory(root);
  privateDirectory(ledgerRoot);
  const claim = NodePath.join(ledgerRoot, `${upstream}.json`);
  let fd;
  try {
    fd = NodeFS.openSync(claim, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let safeToRecover = false;
    const stat = NodeFS.lstatSync(claim);
    if (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      !(stat.mode & 0o077)
    ) {
      try {
        const prior = JSON.parse(NodeFS.readFileSync(claim, "utf8"));
        safeToRecover =
          prior.upstream === upstream &&
          ["failed", "resolved"].includes(prior.status) &&
          prior.safeToRecover === true;
      } catch {
        /* A partial reservation still consumes the attempt and holds recovery. */
      }
    }
    return { started: false, status: "already-attempted", claim, safeToRecover };
  }
  const record = {
    upstream,
    base,
    directory,
    claim,
    model: "gpt-6.1-sol",
    effort: "high",
    started: false,
    status: "reserved",
    safeToRecover: true,
    reservedAt: new Date().toISOString(),
  };
  save(fd, record);
  const parent = NodeFS.openSync(ledgerRoot, "r");
  try {
    NodeFS.fsyncSync(parent);
  } finally {
    NodeFS.closeSync(parent);
  }
  const run =
    io.run ??
    ((exe, args) => {
      const result = NodeChildProcess.spawnSync(exe, args, { encoding: "utf8", timeout: 15000 });
      return { code: result.status ?? 1, text: result.stdout?.trim() ?? "" };
    });
  try {
    const uid = String(process.getuid());
    if (run("/bin/launchctl", ["print", `gui/${uid}`]).code !== 0)
      throw Error("Christine's logged-in GUI session is unavailable.");
    const prompt = resolverPrompt(input);
    NodeFS.writeFileSync(NodePath.join(directory, "resolver-prompt.txt"), prompt, {
      mode: 0o600,
      flag: "wx",
    });
    const args = [
      "asuser",
      uid,
      "/Users/christinesmith/.local/bin/codex",
      "exec",
      "--model",
      record.model,
      "-c",
      'model_reasoning_effort="high"',
      "--ignore-user-config",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      "features.multi_agent=false",
      "--cd",
      config.repository,
      "--json",
      "--output-last-message",
      NodePath.join(directory, "resolver-final.txt"),
      "-",
    ];
    record.started = true;
    record.status = "running";
    // Until the owned process group is proven gone, the source cannot be recovered.
    record.safeToRecover = false;
    save(fd, record);
    const result = await (io.launch ?? launchResolver)({
      exe: "/bin/launchctl",
      args,
      prompt,
      directory,
      repository: config.repository,
      env: input.env ?? process.env,
      onSpawn: (pid) => {
        record.pid = pid;
        save(fd, record);
      },
    });
    Object.assign(record, result, {
      status: result.code === 0 && result.safeToRecover ? "resolved" : "failed",
    });
  } catch (error) {
    record.status = "failed";
    record.reason = error.message;
    if (!record.pid) record.safeToRecover = true;
  } finally {
    record.finishedAt = new Date().toISOString();
    save(fd, record);
    NodeFS.closeSync(fd);
    NodeFS.writeFileSync(
      NodePath.join(directory, "resolver-result.json"),
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
    );
  }
  return record;
}
