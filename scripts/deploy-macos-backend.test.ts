// @effect-diagnostics nodeBuiltinImport:off - This test exercises the standalone host-side operator script with temporary filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";

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
  renderWrapper,
  recoverFailedDeployment,
  validateCandidate,
  validateOptions,
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
    const oldEntry = NodePath.normalize(
      "/Users/millie/.npm/_npx/b56d26d977534b62/node_modules/t3/dist/bin.mjs",
    );
    const oldAlias = NodePath.normalize(
      "/Users/millie/.npm/_npx/b56d26d977534b62/node_modules/.bin/t3",
    );
    const baseDir = NodePath.normalize("/Users/millie/.t3");
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
        command: `node ${oldAlias} serve --host 127.0.0.1 --port 3773 --base-dir ${baseDir}`,
        oldEntry,
        baseDir,
        host: "127.0.0.1",
        port: 3773,
      }),
    ).not.toThrow();
    expect(() =>
      assertProcessIdentity({
        expectedPid: 16658,
        actualPid: 16658,
        command: `node ${oldAlias} serve --host 127.0.0.1 --port 37730 --base-dir ${baseDir}-wrong`,
        oldEntry,
        baseDir,
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

  it("renders loopback-only persistent LaunchAgent arguments and owned wrapper", () => {
    const installation = NodePath.normalize(`/Users/millie/.local/lib/t3-fork/${commit}`);
    const wrapper = renderWrapper("/Users/millie/.local/lib/node-v24.18.0/bin/node", installation);
    expect(wrapper).toContain(`'${NodePath.join(installation, "dist/bin.mjs")}' "$@"`);
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
        SECRET_SHOULD_NOT_BE_COPIED: "never",
      },
    });
    expect(plist).toContain("<string>127.0.0.1</string>");
    expect(plist).toContain("<string>3773</string>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<integer>30</integer>");
    expect(plist).toMatch(
      /<key>SoftResourceLimits<\/key>\s*<dict>\s*<key>NumberOfFiles<\/key>\s*<integer>8192<\/integer>/,
    );
    expect(plist).toContain(DEPLOYMENT_MARKER);
    expect(isOwnedPlist(plist, "com.christinesmith.t3-fork.backend")).toBe(true);
    expect(plist).not.toContain("SECRET_SHOULD_NOT_BE_COPIED");
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

  it("validates the CLI plan and rejects missing client in both modes before mutation", async () => {
    await withTempDirectory(async (root) => {
      const candidate = NodePath.join(root, "candidate");
      await writeCandidate(candidate);
      const preload = NodePath.join(root, "synthetic-millie.cjs");
      // This child-only fixture reaches the execute preflight on any host.
      // Every write or process action is trapped before importing production.
      await NodeFSP.writeFile(
        preload,
        `const os = require('node:os');
const fs = require('node:fs/promises');
const child = require('node:child_process');
const denied = () => { throw new Error('SYNTHETIC MUTATION ATTEMPT'); };
Object.defineProperty(process, 'platform', { value: 'darwin' });
os.userInfo = () => ({ username: 'millie' });
os.homedir = () => '/Users/millie';
for (const key of ['mkdir', 'cp', 'rename', 'writeFile', 'rm', 'chmod', 'unlink', 'rmdir']) fs[key] = denied;
child.execFile = denied;
child.spawn = denied;
process.kill = denied;
require('node:module').syncBuiltinESMExports();
`,
      );
      const args = [
        NodeURL.fileURLToPath(new URL("./deploy-macos-backend.ts", import.meta.url)),
        "--candidate",
        candidate,
        "--commit",
        commit,
        "--base-dir",
        NodePath.join(root, "synthetic-live"),
        "--backup-root",
        NodePath.join(root, "backup"),
        "--smoke-home",
        NodePath.join(root, "smoke"),
        "--expected-old-pid",
        "12345",
      ];
      const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
      const node = process.execPath;
      const plan = await execFile(node, ["--require", preload, ...args, "--dry-run"], {
        windowsHide: true,
      });
      expect(plan.stdout).toContain("PLAN ONLY");
      expect(plan.stderr).not.toContain("SYNTHETIC MUTATION ATTEMPT");
      await NodeFSP.rm(NodePath.join(candidate, "dist/client/index.html"));
      for (const mode of ["--dry-run", "--execute"]) {
        await expect(
          execFile(node, ["--require", preload, ...args, mode], { windowsHide: true }),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining("dist/client/index.html"),
        });
      }
      expect((await NodeFSP.readdir(root)).sort()).toEqual(["candidate", "synthetic-millie.cjs"]);
      expect(await NodeFSP.readFile(NodePath.join(candidate, "dist/bin.mjs"), "utf8")).toBe(
        "#!/usr/bin/env node\n",
      );
    });
  });

  // oxlint-disable-next-line t3code/no-global-process-runtime -- This test only applies to the standalone CLI's real non-Mac host gate.
  it.skipIf(NodeOS.platform() === "darwin")(
    "preserves the real host restriction for execute",
    async () => {
      await withTempDirectory(async (root) => {
        const candidate = NodePath.join(root, "candidate");
        await writeCandidate(candidate);
        const node = process.execPath;
        await expect(
          NodeUtil.promisify(NodeChildProcess.execFile)(
            node,
            [
              NodeURL.fileURLToPath(new URL("./deploy-macos-backend.ts", import.meta.url)),
              "--execute",
              "--candidate",
              candidate,
              "--commit",
              commit,
              "--expected-old-pid",
              "12345",
              "--backup-root",
              NodePath.join(root, "backup"),
              "--smoke-home",
              NodePath.join(root, "smoke"),
            ],
            { windowsHide: true },
          ),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining("restricted to macOS"),
        });
        expect(await NodeFSP.readdir(root)).toEqual(["candidate"]);
      });
    },
  );

  it("selects rollback on HTTP 503 and runs the synthetic recovery callback", async () => {
    await withTempDirectory(async (root) => {
      const wrapper = NodePath.join(root, "wrapper");
      const plist = NodePath.join(root, "launch-agent.plist");
      await NodeFSP.writeFile(wrapper, "candidate wrapper");
      await NodeFSP.writeFile(plist, "candidate plist");
      const server = NodeHttp.createServer((_request, response) => {
        response.writeHead(503);
        response.end("synthetic missing client");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing synthetic listener");
        // Exercise the exported HTTP-status and recovery boundaries, not launchd.
        const status = await new Promise<number>((resolve, reject) => {
          NodeHttp.get(`http://127.0.0.1:${address.port}/`, (response) => {
            response.resume();
            response.on("error", reject);
            response.on("end", () => {
              if (response.statusCode === undefined) reject(new Error("missing HTTP status"));
              else resolve(response.statusCode);
            });
          }).on("error", reject);
        });
        expect(() => assertRootHttpStatus(status)).toThrow("GET / returned HTTP 503");
        const actions: string[] = [];
        try {
          assertRootHttpStatus(status);
        } catch {
          await recoverFailedDeployment(
            true,
            async () => {
              actions.push("restore-only");
            },
            async () => {
              actions.push("rollback");
              await NodeFSP.writeFile(wrapper, "old wrapper");
              await NodeFSP.writeFile(plist, "old plist");
              actions.push("restored-old-fixture");
            },
          );
        }
        expect(actions).toEqual(["rollback", "restored-old-fixture"]);
        expect(await NodeFSP.readFile(wrapper, "utf8")).toBe("old wrapper");
        expect(await NodeFSP.readFile(plist, "utf8")).toBe("old plist");
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });
});
