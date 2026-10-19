// @effect-diagnostics nodeBuiltinImport:off - This test exercises the standalone host-side operator script with temporary filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  assertProcessIdentity,
  assertRootHttpStatus,
  assertLaunchAgentState,
  assertOwnedDestinationContent,
  assertSingleLoopbackListener,
  candidateEntryPath,
  DEPLOYMENT_MARKER,
  DeploymentGuardError,
  idleGuardQueries,
  isOwnedPlist,
  isOwnedWrapper,
  parseArgs,
  parseLsofListeners,
  renderLaunchAgentPlist,
  localEnvironment,
  renderWrapper,
  recoverFailedDeployment,
  validateCandidate,
  validateOptions,
  assertCapacity,
  MINIMUM_FREE_BYTES,
  backupDatabase,
  retirePreviousRollback,
  verifyDatabaseBackup,
  assertInstallMatches,
  cloneCodeTree,
} from "./deploy-macos-backend.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

const baseOptions = (overrides: Partial<Parameters<typeof validateOptions>[0]> = {}) =>
  validateOptions({
    candidate: "/tmp/backend-candidate",
    commit,
    baseDir: "/Users/millie/.t3",
    nodePath: "/Users/millie/.local/lib/node-v24.18.0/bin/node",
    oldEntry: "/Users/millie/.npm/_npx/b56d26d977534b62/node_modules/t3/dist/bin.mjs",
    oldNodePath: "/Users/millie/.local/lib/node-v24.18.0/bin/node",
    backupRoot: "/tmp/t3-backups",
    smokeHome: "/tmp/t3-smoke-home",
    port: 3773,
    smokePort: 38773,
    label: "com.christinesmith.t3-fork.backend",
    expectedOldPid: undefined,
    dryRun: true,
    ...overrides,
  });

const withTempDirectory = async (run: (root: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-backend-helper-test-"));
  try {
    await run(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const writeCandidate = async (candidate: string) => {
  await NodeFSP.mkdir(NodePath.join(candidate, "dist/client/assets"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(candidate, "node_modules/node-pty"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(candidate, "dist/bin.mjs"), "#!/usr/bin/env node\n");
  await NodeFSP.writeFile(NodePath.join(candidate, "dist/client/index.html"), "<html></html>");
  await NodeFSP.writeFile(NodePath.join(candidate, "dist/client/assets/app.js"), "app");
  await NodeFSP.writeFile(NodePath.join(candidate, ".t3-source-commit"), `${commit}\n`);
};

describe("deploy-macos-backend guards", () => {
  it("clones a code tree with links and keeps the clone unchanged after source edits", async () => {
    if (NodeOS.type() !== "Darwin") return;
    await withTempDirectory(async (root) => {
      const source = NodePath.join(root, "source");
      const destination = NodePath.join(root, "clone");
      await NodeFSP.mkdir(NodePath.join(source, "nested"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(source, "nested/code.js"), "synthetic original");
      await NodeFSP.symlink("nested/code.js", NodePath.join(source, "entry.js"));
      await cloneCodeTree(source, destination);
      await NodeFSP.writeFile(NodePath.join(source, "nested/code.js"), "synthetic newer");
      expect(await NodeFSP.readFile(NodePath.join(destination, "entry.js"), "utf8")).toBe(
        "synthetic original",
      );
      expect(await NodeFSP.readlink(NodePath.join(destination, "entry.js"))).toBe("nested/code.js");
      await expect(cloneCodeTree(source, destination)).rejects.toThrow();
    });
  });
  it("fails closed below the rollback reserve", () => {
    expect(() => assertCapacity(MINIMUM_FREE_BYTES - 1)).toThrow("Less than 20 GiB");
    expect(() => assertCapacity(Number.NaN)).toThrow();
    expect(() => assertCapacity(MINIMUM_FREE_BYTES)).not.toThrow();
    expect(() => assertCapacity(MINIMUM_FREE_BYTES + 4096, 8192)).toThrow("projected free");
    expect(() => assertCapacity(MINIMUM_FREE_BYTES + 8192, 8192)).not.toThrow();
    expect(() => assertCapacity(MINIMUM_FREE_BYTES, -1)).toThrow();
  });
  it("reuses only a byte-identical bundle without replacing existing code", async () => {
    await withTempDirectory(async (root) => {
      const candidate = NodePath.join(root, "candidate");
      const installed = NodePath.join(root, "installed");
      await writeCandidate(candidate);
      await NodeFSP.cp(candidate, installed, { recursive: true });
      await expect(assertInstallMatches(candidate, installed)).resolves.toBeUndefined();
      await NodeFSP.writeFile(NodePath.join(installed, "dist/client/assets/app.js"), "different");
      await expect(assertInstallMatches(candidate, installed)).rejects.toThrow(
        "differs from the verified candidate",
      );
      expect(
        await NodeFSP.readFile(NodePath.join(installed, "dist/client/assets/app.js"), "utf8"),
      ).toBe("different");
    });
  });

  // oxlint-disable-next-line t3code/no-global-process-runtime -- Native clone support belongs to the host filesystem, not an injected Effect platform.
  it.skipIf(NodeOS.platform() !== "darwin")(
    "clones a checkpointed SQLite rollback and keeps later writes independent",
    async () => {
      await withTempDirectory(async (root) => {
        const source = NodePath.join(root, "source.sqlite");
        const backup = NodePath.join(root, "rollback.sqlite");
        const database = new NodeSqlite.DatabaseSync(source);
        database.exec(
          "PRAGMA journal_mode=WAL; CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES ('saved reply');",
        );
        const before = await NodeFSP.statfs(root);
        await backupDatabase(source, backup);
        await verifyDatabaseBackup(backup);
        database.exec("INSERT INTO saved VALUES ('later reply');");
        const clone = new NodeSqlite.DatabaseSync(backup, { readOnly: true });
        try {
          expect(clone.prepare("SELECT count(*) AS n FROM saved").get()).toEqual({ n: 1 });
          expect(clone.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
          expect((await NodeFSP.stat(source)).ino).not.toBe((await NodeFSP.stat(backup)).ino);
          const after = await NodeFSP.statfs(root);
          expect((before.bavail - after.bavail) * before.bsize).toBeLessThan(16 * 1024 * 1024);
          await expect(backupDatabase(source, backup)).rejects.toThrow("already exists");
        } finally {
          clone.close();
          database.close();
        }
      });
    },
  );

  it("retires only the last owned rollback and refuses unrelated paths", async () => {
    await withTempDirectory(async (root) => {
      const old = NodePath.join(root, "20261013010000-0123456789ab");
      const current = NodePath.join(root, "20261013020000-0123456789ab");
      await NodeFSP.mkdir(old);
      await NodeFSP.mkdir(current);
      await NodeFSP.writeFile(NodePath.join(old, "state.sqlite"), "synthetic");
      await NodeFSP.writeFile(NodePath.join(current, "state.sqlite"), "synthetic");
      const marker = NodePath.join(root, "latest-rollback.json");
      await NodeFSP.writeFile(
        marker,
        JSON.stringify({ marker: DEPLOYMENT_MARKER, directory: old }),
      );
      await retirePreviousRollback(root, current);
      await expect(NodeFSP.stat(old)).rejects.toThrow();
      expect((await NodeFSP.stat(current)).isDirectory()).toBe(true);
      await NodeFSP.writeFile(
        marker,
        JSON.stringify({ marker: DEPLOYMENT_MARKER, directory: NodeOS.tmpdir() }),
      );
      await expect(retirePreviousRollback(root, current)).rejects.toThrow("escapes its root");
      expect((await NodeFSP.stat(current)).isDirectory()).toBe(true);
    });
  });
  it("requires an exact commit and fresh smoke home for execute mode", () => {
    expect(() =>
      parseArgs([
        "--execute",
        "--commit",
        commit,
        "--backup-root",
        "/tmp/backup",
        "--smoke-home",
        "/tmp/smoke",
      ]),
    ).toThrow("--execute requires --expected-old-pid");
    expect(() => baseOptions({ commit: "short" })).toThrow("full 40-character SHA");
  });

  it("parses only exact loopback listeners and rejects PID drift", () => {
    const listeners = parseLsofListeners(
      "p16658\ncnode\ntIPv4\nn127.0.0.1:3773\np17777\ncother\ntIPv4\nn*:3773\n",
      "127.0.0.1",
      3773,
    );
    expect(listeners).toEqual([{ pid: 16658, name: "127.0.0.1:3773" }]);
    expect(() => assertSingleLoopbackListener(listeners, 16658)).not.toThrow();
    expect(() => assertSingleLoopbackListener(listeners, 17777)).toThrow(
      "does not match expected PID",
    );
    expect(() =>
      assertProcessIdentity({
        expectedPid: 16658,
        actualPid: 16658,
        command:
          "node /Users/millie/.npm/_npx/b56d26d977534b62/node_modules/.bin/t3 serve --host 127.0.0.1 --port 3773 --base-dir /Users/millie/.t3",
        oldEntry: "/Users/millie/.npm/_npx/b56d26d977534b62/node_modules/t3/dist/bin.mjs",
        baseDir: "/Users/millie/.t3",
        host: "127.0.0.1",
        port: 3773,
      }),
    ).not.toThrow();
    expect(() =>
      assertProcessIdentity({
        expectedPid: 16658,
        actualPid: 16658,
        command:
          "node /Users/millie/.npm/_npx/b56d26d977534b62/node_modules/.bin/t3 serve --host 127.0.0.1 --port 37730 --base-dir /Users/millie/.t3-wrong",
        oldEntry: "/Users/millie/.npm/_npx/b56d26d977534b62/node_modules/t3/dist/bin.mjs",
        baseDir: "/Users/millie/.t3",
        host: "127.0.0.1",
        port: 3773,
      }),
    ).toThrow("exact --base-dir");
    expect(() =>
      assertProcessIdentity({
        expectedPid: 16658,
        actualPid: 16659,
        command: "node unrelated --host 127.0.0.1 --port 3773 --base-dir /Users/millie/.t3",
        oldEntry: "/old/t3/dist/bin.mjs",
        baseDir: "/Users/millie/.t3",
        host: "127.0.0.1",
        port: 3773,
      }),
    ).toThrow("listener PID changed");
  });

  it("accepts the real staged bundle layout and an in-bundle dependency symlink", async () => {
    await withTempDirectory(async (root) => {
      const candidate = NodePath.join(root, "candidate");
      await writeCandidate(candidate);
      await validateCandidate(baseOptions({ candidate }));
      await expect(candidateEntryPath(candidate)).resolves.toBe(
        NodePath.join(candidate, "dist/bin.mjs"),
      );
    });
  });

  it("rejects missing client files before deployment and checks the copied install", async () => {
    await withTempDirectory(async (root) => {
      const candidate = NodePath.join(root, "candidate");
      await writeCandidate(candidate);
      await NodeFSP.rm(NodePath.join(candidate, "dist/bin.mjs"));
      await expect(validateCandidate(baseOptions({ candidate }))).rejects.toThrow("dist/bin.mjs");
      await NodeFSP.writeFile(NodePath.join(candidate, "dist/bin.mjs"), "#!/usr/bin/env node\n");
      await NodeFSP.rm(NodePath.join(candidate, "dist/client/index.html"));
      await expect(validateCandidate(baseOptions({ candidate }))).rejects.toThrow(
        "dist/client/index.html",
      );
      await NodeFSP.writeFile(NodePath.join(candidate, "dist/client/index.html"), "<html></html>");
      await NodeFSP.rm(NodePath.join(candidate, "dist/client/assets/app.js"));
      await expect(validateCandidate(baseOptions({ candidate }))).rejects.toThrow(
        "dist/client/assets files",
      );
      await NodeFSP.writeFile(NodePath.join(candidate, "dist/client/assets/app.js"), "app");
      const installed = NodePath.join(root, "installed");
      await NodeFSP.cp(candidate, installed, { recursive: true });
      await validateCandidate(baseOptions({ candidate: installed }));
      await NodeFSP.rm(NodePath.join(installed, "dist/client/index.html"));
      await expect(validateCandidate(baseOptions({ candidate: installed }))).rejects.toThrow(
        "dist/client/index.html",
      );
    });
  });

  it("rejects a candidate symlink that escapes the bundle and a mismatched stamp", async () => {
    await withTempDirectory(async (root) => {
      const candidate = NodePath.join(root, "candidate");
      await writeCandidate(candidate);
      await NodeFSP.writeFile(
        NodePath.join(candidate, ".t3-source-commit"),
        "fedcba9876543210fedcba9876543210fedcba98\n",
      );
      const outside = NodePath.join(root, "outside");
      await NodeFSP.writeFile(outside, "outside");
      await NodeFSP.symlink(outside, NodePath.join(candidate, "dist/escape"));
      await expect(validateCandidate(baseOptions({ candidate }))).rejects.toThrow(
        "escapes its bundle",
      );
      await NodeFSP.rm(NodePath.join(candidate, "dist/escape"));
      await NodeFSP.writeFile(NodePath.join(candidate, ".t3-source-commit"), "bad\n");
      await expect(validateCandidate(baseOptions({ candidate }))).rejects.toThrow("does not match");
    });
  });

  it("requires a 200 from the client root and rolls back after a stopped switch", async () => {
    expect(() => assertRootHttpStatus(200)).not.toThrow();
    for (const status of [302, 404, 503]) {
      expect(() => assertRootHttpStatus(status)).toThrow(`GET / returned HTTP ${status}`);
    }
    const actions: string[] = [];
    const restore = async () => {
      actions.push("restore");
    };
    const rollback = async () => {
      actions.push("rollback");
    };
    try {
      assertRootHttpStatus(503);
    } catch {
      await recoverFailedDeployment(true, restore, rollback);
    }
    expect(actions).toEqual(["rollback"]);
    await recoverFailedDeployment(false, restore, rollback);
    expect(actions).toEqual(["rollback", "restore"]);
  });

  it("preserves the candidate when the external rollback idle guard rejects", async () => {
    await withTempDirectory(async (root) => {
      const guard = NodePath.join(root, "idle-guard.py");
      const invoked = NodePath.join(root, "invoked");
      await NodeFSP.writeFile(
        guard,
        `import pathlib,sys\nassert sys.argv[1:] == ['--gate-only']\npathlib.Path(${JSON.stringify(invoked)}).write_text('checked')\nraise SystemExit(1)\n`,
      );
      const actions: string[] = [];
      const restore = async () => {
        actions.push("restore");
      };
      const rollback = async () => {
        actions.push("stop candidate and restore old deployment");
      };
      vi.stubEnv("T3CODE_PRESTOP_GUARD", guard);
      try {
        await expect(recoverFailedDeployment(true, restore, rollback)).rejects.toThrow(
          "overnight idle gate",
        );
        expect(await NodeFSP.readFile(invoked, "utf8")).toBe("checked");
        expect(actions).toEqual([]);
        await recoverFailedDeployment(false, restore, rollback);
        expect(actions).toEqual(["restore"]);
        await NodeFSP.writeFile(guard, "import sys\nassert sys.argv[1:] == ['--gate-only']\n");
        await recoverFailedDeployment(true, restore, rollback);
        expect(actions).toEqual(["restore", "stop candidate and restore old deployment"]);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("renders loopback-only persistent LaunchAgent arguments and owned wrapper", () => {
    const wrapper = renderWrapper(
      "/Users/millie/.local/lib/node-v24.18.0/bin/node",
      `/Users/millie/.local/lib/t3-fork/${commit}`,
    );
    expect(wrapper).toContain("dist/bin.mjs");
    expect(isOwnedWrapper(wrapper)).toBe(true);
    const plist = renderLaunchAgentPlist({
      label: "com.christinesmith.t3-fork.backend",
      commit,
      wrapperPath: "/Users/millie/.local/bin/t3",
      baseDir: "/Users/millie/.t3",
      port: 3773,
      environment: {
        HOME: "/Users/millie",
        CODEX_HOME: "/Users/millie/.codex",
        T3_WORK_BROWSER_BINDING: "/fixture/work-browser/t3_binding.mjs",
        T3_WORK_BROWSER_MACHINE: "millie",
        T3_WORK_BROWSER_DECK_TASK: "unrelated-global-task",
        SECRET_SHOULD_NOT_BE_COPIED: "never",
      },
    });
    expect(plist).toContain("<string>127.0.0.1</string>");
    expect(plist).toContain("<string>3773</string>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<integer>30</integer>");
    expect(plist).toMatch(
      /<key>SoftResourceLimits<\/key>\s*<dict>\s*<key>NumberOfFiles<\/key>\s*<integer>16384<\/integer>/,
    );
    expect(plist).toContain("<key>T3CODE_BACKEND_LAUNCHD</key>\n    <string>1</string>");
    expect(plist).toContain(DEPLOYMENT_MARKER);
    expect(isOwnedPlist(plist, "com.christinesmith.t3-fork.backend")).toBe(true);
    expect(plist).not.toContain("SECRET_SHOULD_NOT_BE_COPIED");
    expect(plist).toContain(
      "<key>T3_WORK_BROWSER_BINDING</key>\n    <string>/fixture/work-browser/t3_binding.mjs</string>",
    );
    expect(plist).toContain("<key>T3_WORK_BROWSER_MACHINE</key>\n    <string>millie</string>");
    expect(plist).not.toContain("T3_WORK_BROWSER_DECK_TASK");
  });

  it("routes SSH production starts through launchd without starting another runtime", async () => {
    await withTempDirectory(async (root) => {
      const launchctl = NodePath.join(root, "launchctl");
      const node = NodePath.join(root, "node");
      await NodeFSP.writeFile(launchctl, '#!/bin/sh\nprintf "launchd:%s\\n" "$*"\nexit 7\n', {
        mode: 0o700,
      });
      await NodeFSP.writeFile(node, '#!/bin/sh\nprintf "runtime:%s\\n" "$*"\n', { mode: 0o700 });
      const options = { label: "fixture.backend", baseDir: "/fixture/home", port: 3773 };
      const wrapper = renderWrapper(node, "/fixture/install", options);
      const serve = [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "3773",
        "--base-dir",
        "/fixture/home",
      ];
      const execute = (args: string[], owned: boolean) =>
        NodeChildProcess.spawnSync("/bin/sh", ["-c", wrapper, "t3", ...args], {
          env: {
            ...process.env,
            PATH: `${root}:/usr/bin:/bin`,
            T3CODE_BACKEND_LAUNCHD: owned ? "1" : "0",
          },
          encoding: "utf8",
        });
      const ssh = execute(serve, false);
      expect(ssh.status).toBe(7);
      expect(ssh.stdout).toMatch(/^launchd:kickstart gui\/\d+\/fixture.backend/);
      expect(ssh.stdout).not.toContain("runtime:");
      const owned = execute(serve, true);
      expect(owned.status).toBe(0);
      expect(owned.stdout).toContain("runtime:/fixture/install/dist/bin.mjs serve");
      const inspect = execute(["agent", "providers"], false);
      expect(inspect.status).toBe(0);
      expect(inspect.stdout).toContain("runtime:/fixture/install/dist/bin.mjs agent providers");
      const isolated = execute(["serve", "--port", "38773"], false);
      expect(isolated.status).toBe(0);
      expect(isolated.stdout).toContain("runtime:/fixture/install/dist/bin.mjs serve --port 38773");
    });
  });

  it("fails closed for unknown wrapper/plist ownership and loaded labels without disk state", () => {
    expect(() =>
      assertOwnedDestinationContent("#!/bin/sh\necho existing\n", "wrapper", "label"),
    ).toThrow("not owned");
    expect(() => assertOwnedDestinationContent("<plist><dict/></plist>", "plist", "label")).toThrow(
      "not owned",
    );
    expect(() => assertLaunchAgentState(true, undefined, "com.example.t3")).toThrow(
      "loaded without a matching",
    );
    expect(() => assertLaunchAgentState(false, "<plist><dict/></plist>", "com.example.t3")).toThrow(
      "not owned",
    );
  });

  it("keeps stopped historical requests while blocking active or unaccounted requests", async () => {
    const ready = new NodeSqlite.DatabaseSync(":memory:");
    try {
      ready.exec(
        "CREATE TABLE provider_session_runtime(thread_id TEXT PRIMARY KEY,status TEXT); CREATE TABLE projection_thread_sessions(thread_id TEXT PRIMARY KEY,status TEXT,active_turn_id TEXT); INSERT INTO provider_session_runtime VALUES('connected','running'); INSERT INTO projection_thread_sessions VALUES('connected','ready',NULL);",
      );
      const count = () =>
        (ready.prepare(idleGuardQueries.activeRuntime).get() as { "COUNT(*)": number })["COUNT(*)"];
      expect(count()).toBe(0);
      ready.exec("UPDATE projection_thread_sessions SET active_turn_id='turn';");
      expect(count()).toBe(1);
      ready.exec("UPDATE projection_thread_sessions SET active_turn_id=NULL,status='running';");
      expect(count()).toBe(1);
      ready.exec("UPDATE projection_thread_sessions SET status=NULL;");
      expect(count()).toBe(1);
      ready.exec("DELETE FROM projection_thread_sessions;");
      expect(count()).toBe(1);
      ready.exec(
        "INSERT INTO projection_thread_sessions VALUES('connected','ready',NULL); UPDATE provider_session_runtime SET status='starting';",
      );
      expect(count()).toBe(1);
    } finally {
      ready.close();
    }
    await withTempDirectory(async (root) => {
      const db = new NodeSqlite.DatabaseSync(NodePath.join(root, "idle-guard.sqlite"));
      try {
        db.exec(`
          CREATE TABLE provider_session_runtime (thread_id TEXT PRIMARY KEY, status TEXT);
          CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT, active_turn_id TEXT);
          CREATE TABLE projection_pending_approvals (request_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
          CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, pending_user_input_count INTEGER);
          INSERT INTO provider_session_runtime VALUES ('historical', 'stopped'), ('active', 'running');
          INSERT INTO projection_thread_sessions VALUES ('historical', 'running', 'old-turn'), ('active', 'running', 'live-turn'), ('missing', 'running', 'unknown-turn');
          INSERT INTO projection_pending_approvals VALUES ('historical-approval', 'historical', 'pending'), ('active-approval', 'active', 'pending'), ('missing-approval', 'missing', 'pending');
          INSERT INTO projection_threads VALUES ('historical', 1), ('active', 1), ('missing', 1);
        `);
        const count = (query: string) =>
          Number((db.prepare(query).get() as Record<string, unknown>)["COUNT(*)"]);
        expect(count(idleGuardQueries.pendingInputs)).toBe(2);
        expect(count(idleGuardQueries.pendingApprovals)).toBe(2);
        expect(count(idleGuardQueries.unaccountedProjectionActivity)).toBe(2);
        db.exec(
          "UPDATE provider_session_runtime SET status = 'stopped' WHERE thread_id = 'active';",
        );
        expect(count(idleGuardQueries.pendingInputs)).toBe(1);
        expect(count(idleGuardQueries.pendingApprovals)).toBe(1);
        expect(count(idleGuardQueries.unaccountedProjectionActivity)).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  it("keeps dry-run side-effect free by requiring only a plan", () => {
    const options = parseArgs([
      "--dry-run",
      "--commit",
      commit,
      "--backup-root",
      "/tmp/t3-backups",
      "--smoke-home",
      "/tmp/t3-smoke-home",
    ]);
    expect(options.dryRun).toBe(true);
    expect(options.port).toBe(3773);
    expect(DeploymentGuardError).toBeDefined();
  });
});


describe("live launch environment", () => {
  it("keeps the admitted browser binding through environment selection and plist rendering", () => {
    const selected = localEnvironment({
      HOME: "/Users/millie", PATH: "/usr/bin:/bin",
      CODEX_APP_SERVER_TRANSPORT: "fixture-native-transport",
      T3_WORK_BROWSER_BINDING: "/private/fixture/browser-binding.mjs",
      T3_WORK_BROWSER_MACHINE: "millie",
      UNRELATED_SYNTHETIC_SECRET: "must-not-be-forwarded",
    });
    expect(selected.T3_WORK_BROWSER_BINDING).toBe("/private/fixture/browser-binding.mjs");
    expect(selected.T3_WORK_BROWSER_MACHINE).toBe("millie");
    expect(selected.CODEX_APP_SERVER_TRANSPORT).toBe("fixture-native-transport");
    expect(selected.UNRELATED_SYNTHETIC_SECRET).toBeUndefined();
    const plist = renderLaunchAgentPlist({label: "com.fixture.backend", commit,
      wrapperPath: "/fixture/t3", baseDir: "/fixture/home", port: 3773, environment: selected});
    expect(plist).toContain("<key>T3_WORK_BROWSER_BINDING</key>");
    expect(plist).toContain("<string>/private/fixture/browser-binding.mjs</string>");
    expect(plist).toContain("<key>T3_WORK_BROWSER_MACHINE</key>");
    expect(plist).not.toContain("UNRELATED_SYNTHETIC_SECRET");
  });
});
