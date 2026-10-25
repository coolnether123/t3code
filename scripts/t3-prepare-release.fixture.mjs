import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const prepare = NodeURL.fileURLToPath(new URL("./t3-prepare-release.ps1", import.meta.url));
const powershell = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

NodeTest.test(
  "default repository resolves after PowerShell parameter binding without writing a dry run",
  (t) => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-default-repository-fixture-"),
    );
    t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
    const releaseRoot = NodePath.join(root, "releases");
    const result = NodeChildProcess.spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        "scripts/t3-prepare-release.ps1",
        "-ReleaseRoot",
        releaseRoot,
        "-ArtifactRoot",
        NodePath.join(root, "artifacts"),
        "-DryRun",
      ],
      { cwd: NodePath.dirname(NodePath.dirname(prepare)), encoding: "utf8", windowsHide: true },
    );
    NodeAssert.equal(result.status, 0, result.stdout + result.stderr);
    NodeAssert.match(result.stdout, /Would prepare [a-f0-9]{40}/);
    NodeAssert.equal(NodeFS.existsSync(releaseRoot), false);
  },
);

function fixture(t, missingClient = false) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-build-fixture-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const repository = NodePath.join(root, "repository");
  NodeFS.mkdirSync(repository);
  const write = (name, text) => {
    const file = NodePath.join(repository, name);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, text);
  };
  write("package.json", '{"type":"module"}');
  write("tracked.ts", "synthetic source");
  write(".repos/reference.ts", "read-only reference, not a build input");
  write("apps/mobile/src/features/usage/usageProviders.ts", "synthetic tracked override");
  write("apps/server/src/secrets/Fixture.ts", "synthetic source, no private payload");
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  git("init", "-q");
  git(
    "add",
    "package.json",
    "tracked.ts",
    ".repos/reference.ts",
    "apps/mobile/src/features/usage/usageProviders.ts",
    "apps/server/src/secrets/Fixture.ts",
  );
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=NUL",
    "commit",
    "-qm",
    "synthetic fixture",
  );
  write(".env", "synthetic private setting");
  // This fixture substitutes only the toolchain, never the preparation script.
  write(
    "node_modules/vite-plus/bin/vp",
    `
    const NodeFS = require('node:fs');
    const NodePath = require('node:path');
    const cwd = process.cwd();
    if (process.argv[2] === 'i') {
      const target = NodePath.join(cwd,'node_modules/vite-plus/bin/vp');
      NodeFS.mkdirSync(NodePath.dirname(target),{recursive:true});
      NodeFS.copyFileSync(__filename,target);
    }
    if (process.argv[2] === 'build') {
      NodeFS.mkdirSync(NodePath.join(cwd,'dist'),{recursive:true});
      NodeFS.writeFileSync(NodePath.join(cwd,'dist/index.html'),'synthetic client');
    }
    if (process.argv[2] === 'pack' && cwd.endsWith('server')) {
      NodeFS.mkdirSync(NodePath.join(cwd,'dist/client'),{recursive:true});
      NodeFS.writeFileSync(NodePath.join(cwd,'dist/bin.mjs'),'synthetic server');
      if (!${missingClient}) NodeFS.writeFileSync(NodePath.join(cwd,'dist/client/index.html'),'synthetic served client');
    }
  `,
  );
  for (const name of ["apps/server", "apps/web", "apps/desktop"])
    write(`${name}/fixture.txt`, "synthetic");
  git("add", "apps/server/fixture.txt", "apps/web/fixture.txt", "apps/desktop/fixture.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=NUL",
    "commit",
    "-qm",
    "synthetic packages",
  );
  const commit = git("rev-parse", "HEAD").trim();
  const releaseRoot = NodePath.join(root, "releases");
  const artifactRoot = NodePath.join(root, "artifacts");
  const run = () =>
    NodeChildProcess.spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        prepare,
        "-Repository",
        repository,
        "-Commit",
        commit,
        "-ReleaseRoot",
        releaseRoot,
        "-ArtifactRoot",
        artifactRoot,
      ],
      { encoding: "utf8", windowsHide: true },
    );
  return { root, releaseRoot, commit, run, git };
}

NodeTest.test(
  "preparation builds an isolated exact-commit projection and records its client artifacts",
  (t) => {
    const f = fixture(t);
    const result = f.run();
    NodeAssert.equal(result.status, 0, result.stdout + result.stderr);
    const release = NodePath.join(f.releaseRoot, f.commit);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(release, "tracked.ts"), "utf8"),
      "synthetic source",
    );
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(release, ".env")), false);
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(release, ".repos")), false);
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(release, "apps/mobile/src/features/usage/usageProviders.ts")),
      true,
    );
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(release, "apps/server/src/secrets/Fixture.ts")),
      true,
    );
    NodeAssert.equal(
      JSON.parse(
        NodeFS.readFileSync(NodePath.join(release, "release.json"), "utf8").replace(/^\uFEFF/, ""),
      ).commit,
      f.commit,
    );
    NodeAssert.equal(f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
    NodeAssert.equal(f.run().status, 1);
  },
);

NodeTest.test(
  "a build without the served client is refused and leaves no successful release receipt",
  (t) => {
    const f = fixture(t, true);
    const result = f.run();
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(result.stderr, /missing required artifact/);
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(f.releaseRoot, f.commit, "release.json")),
      false,
    );
    NodeAssert.equal(f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
  },
);
