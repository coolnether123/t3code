// @effect-diagnostics nodeBuiltinImport:off - verifies a real shell dry-run and filesystem no-write contract.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "vite-plus/test";

const scriptPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "launch-t3-code-macos.sh",
);

const source = NodeFS.readFileSync(scriptPath, "utf8");
const bash = NodeOS.type() === "Windows_NT" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";

describe("launch-t3-code-macos", () => {
  it("recognizes a recovered headless backend without claiming desktop children", () => {
    const roots = source.match(/roots\(\) \{[\s\S]*?\n\}(?=\nroot\(\))/)?.[0];
    assert.isString(roots);
    const app = "/Applications/T3 Code (Alpha).app";
    const exe = `${app}/Contents/MacOS/T3 Code (Alpha)`;
    const entry = `${app}/Contents/Resources/app.asar/apps/server/dist/bin.mjs`;
    const rows = [
      `100 ${exe}`,
      `101 ${exe} ${entry} --bootstrap-fd 3`,
      `102 ${exe} --type=renderer`,
      `200 ${exe} ${entry} serve --mode web --base-dir /Users/test/.t3 --host 127.0.0.1 --port 3773 --no-browser`,
      `201 ${exe} ${entry} serve --mode web --base-dir /Users/other/.t3 --host 127.0.0.1 --port 3773 --no-browser`,
    ];
    const program = [
      `APP_PATH='${app}'; T3_HOME=/Users/test/.t3; SERVER_PORT=3773`,
      `ps() { printf '%s\\n' ${rows.map((row) => `'${row}'`).join(" ")}; }`,
      roots,
      `roots '${exe}'`,
    ].join("\n");
    const result = NodeChildProcess.execFileSync(bash, ["-c", program], { encoding: "utf8" });
    assert.deepEqual(result.trim().split(/\r?\n/), ["100", "200"]);
  });

  it.each(["preparing", "queued", "starting", "running", "waiting", "completed", "failed"])(
    "checks %s snapshot state even without an active run ID",
    (status) => {
      const parser = source.match(/\| node -e '([\s\S]*?)'\)/)?.[1];
      assert.isString(parser);
      const output = NodeChildProcess.execFileSync(process.execPath, ["-e", parser!], {
        input: JSON.stringify({
          environmentId: "synthetic",
          threadCount: 1,
          listPage: { nextOffset: null },
          threads: [{ status, activeRunId: null, pendingRuntimeRequest: null }],
        }),
        encoding: "utf8",
      });
      assert.equal(
        output,
        ["completed", "failed"].includes(status)
          ? "synthetic||idle"
          : "synthetic||busy:active run or pending request",
      );
    },
  );

  it("is valid bash without executing the deployment", () => {
    NodeChildProcess.execFileSync("/bin/bash", ["-n", scriptPath]);
  });

  it("requires a pinned source and explicit backup boundary", () => {
    assert.include(source, "--expected-commit");
    assert.include(source, "--backup-root");
    assert.include(source, "source commit is $actual, expected $EXPECTED_COMMIT");
    assert.include(source, "source checkout has uncommitted changes");
    assert.include(source, "t3codeCommitHash");
    assert.include(source, "cut -c1-12");
    assert.include(source, "grep -Eo");
    assert.notInclude(source, 'grep -Fq "$EXPECTED_COMMIT"');
    assert.include(source, "backup root is inside source checkout");
    assert.include(source, "source checkout is inside backup root");
  });

  it("uses scoped process ownership and consistent SQLite backup", () => {
    assert.include(source, "ps -axo pid=,command=");
    assert.include(source, 'row="${row#"${row%%[![:space:]]*}"}"');
    assert.include(source, "ps -axo pid=,ppid=");
    assert.include(source, "lsof -nP -t -iTCP:");
    assert.notInclude(source, "VACUUM INTO");
    assert.include(source, 'storage checkpoint "$T3_HOME/userdata/state.sqlite"');
    assert.include(source, 'storage verify "$out"');
    assert.include(source, 'storage clone "$db" "$out"');
    assert.include(source, "T3_HOME");
    assert.include(source, "APP_SUPPORT_PATH");
    assert.notMatch(source, /\b(?:pkill|pgrep|killall)\b/);
  });

  it("has recoverable app swap and API health gates", () => {
    assert.include(source, '"${T3CODE_PRESERVE_PENDING_REQUESTS:-0}" == 1');
    assert.include(source, "Pending preservation requires the exact pre-stop fingerprint guard");
    assert.include(source, "write_state ready-to-swap");
    assert.include(source, "write_state old-moved");
    assert.include(source, "write_state new-installed");
    assert.include(source, 'new="$app_parent/.$app_name.new.$RUN_ID.app"');
    assert.include(source, "failed-candidate-");
    assert.include(source, "/.well-known/t3/environment");
    assert.include(source, "/api/auth/session");
    assert.include(source, "t3 agent snapshot");
    assert.include(source, "projection_thread_sessions");
    assert.include(source, "projection_pending_approvals");
    assert.include(source, "pending_user_input_count");
    assert.include(source, '[[ ! -e "$db-wal" && ! -e "$db-shm" ]]');
    assert.include(source, '"file:$uri?immutable=1"');
    assert.include(source, "EXPECTED_ENVIRONMENT_ID");
    assert.include(source, "dry run complete: no files, processes, app/data");
    assert.include(source, '[[ -f "$STATE_PATH" ]] || return 0');
  });

  it("sets aside only the current database a failed first start created", () => {
    const helper = source.match(/set_aside_first_start_database\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.isString(helper);
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-first-start-"));
    try {
      const userdata = NodePath.join(root, "userdata");
      NodeFS.mkdirSync(NodePath.join(userdata, ".v2-import-x"), { recursive: true });
      for (const name of [
        "state.sqlite",
        "state.sqlite-wal",
        "statev2.sqlite",
        "statev2.sqlite-wal",
        "statev2.sqlite-shm",
      ])
        NodeFS.writeFileSync(NodePath.join(userdata, name), name);
      const program = [
        "set -euo pipefail",
        helper,
        'set_aside_first_start_database "$1" "$2"',
        'printf "|"; set_aside_first_start_database "$1" "$2-again"',
      ].join("\n");
      const output = NodeChildProcess.execFileSync(
        bash,
        [
          "-c",
          program,
          "test",
          userdata.replaceAll("\\", "/"),
          NodePath.join(root, "aside").replaceAll("\\", "/"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(output, "statev2.sqlite statev2.sqlite-wal statev2.sqlite-shm .v2-import-x |");
      assert.deepEqual(NodeFS.readdirSync(userdata).toSorted(), [
        "state.sqlite",
        "state.sqlite-wal",
      ]);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(root, "aside/statev2.sqlite"), "utf8"),
        "statev2.sqlite",
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("follows first-start migration progress through the database files", () => {
    const helper = source.match(/first_start_signature\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.isString(helper);
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-first-start-"));
    const signature = () =>
      NodeChildProcess.execFileSync(
        bash,
        ["-c", `${helper}\nfirst_start_signature "$1"`, "test", root.replaceAll("\\", "/")],
        {
          encoding: "utf8",
        },
      );
    try {
      assert.equal(signature(), "");
      NodeFS.writeFileSync(NodePath.join(root, "statev2.sqlite"), "db");
      NodeFS.writeFileSync(NodePath.join(root, "statev2.sqlite-wal"), "w");
      const migrating = signature();
      assert.notEqual(migrating, "");
      assert.equal(signature(), migrating);
      NodeFS.appendFileSync(NodePath.join(root, "statev2.sqlite-wal"), "more");
      assert.notEqual(signature(), migrating);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits longer only for a first start and rolls that database aside", () => {
    assert.include(source, '[[ -e "$T3_HOME/userdata/statev2.sqlite" ]] || FIRST_V2_START=1');
    assert.include(source, 'if ! launch_verify "$first_mode"; then');
    assert.include(source, '[[ "$mode" == first-start ]] && { limit="$FIRST_START_WAIT_SECONDS"');
    assert.include(source, '"$RUN_DIR/failed-first-start-database"');
    assert.match(source, /launch_previous\(\) \{[\s\S]*?\n    launch_verify\n/);
  });

  it("launches through LaunchServices so saved connections stay readable", () => {
    assert.include(source, 'open -g -n -a "$APP_PATH" --env "T3CODE_HOME=$T3_HOME"');
    assert.notInclude(source, 'T3CODE_PORT="$SERVER_PORT" "$exe"');
  });

  it("executes a real dry-run without creating output or deployment state", () => {
    // The launcher is intentionally macOS-only. Run this integration check on
    // the target platform; static tests above still protect the contract on CI.
    if (NodeOS.type() !== "Darwin") return;

    const sourceRoot = NodePath.resolve(NodePath.dirname(scriptPath), "..");
    const temporaryRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-macos-dry-run-"),
    );
    const backupRoot = NodePath.join(temporaryRoot, "backup-root");
    const artifactDir = NodePath.join(temporaryRoot, "artifact-output");
    const git = (args: string[]) =>
      NodeChildProcess.execFileSync("git", ["-C", sourceRoot, ...args], {
        encoding: "utf8",
      }).trim();
    const beforeStatus = git(["status", "--porcelain", "--untracked-files=normal"]);

    try {
      const output = NodeChildProcess.execFileSync(
        "/bin/bash",
        [
          scriptPath,
          "--dry-run",
          "--source-root",
          sourceRoot,
          "--expected-branch",
          git(["branch", "--show-current"]),
          "--expected-commit",
          git(["rev-parse", "HEAD"]),
          "--backup-root",
          backupRoot,
          "--artifact-dir",
          artifactDir,
        ],
        { encoding: "utf8" },
      );

      assert.include(output, "dry run complete");
      assert.isFalse(NodeFS.existsSync(backupRoot));
      assert.isFalse(NodeFS.existsSync(artifactDir));
      assert.equal(git(["status", "--porcelain", "--untracked-files=normal"]), beforeStatus);
    } finally {
      NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
