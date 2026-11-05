// @effect-diagnostics nodeBuiltinImport:off - Private filesystem and Git fixtures for an operator command.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { assertBackendStagePaths, stageMacosBackend } from "./stage-macos-backend.ts";

const commit = "a".repeat(40);
const options = {
  sourceRoot: "/tmp/source",
  output: "/tmp/candidate",
  commit,
  arch: "arm64" as const,
};

describe("macOS backend staging boundary", () => {
  it("rejects broad, relative, unpinned and source-nested destinations", () => {
    for (const change of [
      { output: "/" },
      { output: "relative" },
      { output: "/tmp/source/candidate" },
      { output: "/tmp/source" },
      { commit: "HEAD" },
    ])
      expect(() => assertBackendStagePaths({ ...options, ...change })).toThrow();
    expect(() => assertBackendStagePaths(options)).not.toThrow();
  });

  it("never overwrites an existing candidate", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-stage-existing-"));
    try {
      await NodeFSP.writeFile(NodePath.join(root, "keep"), "original");
      await expect(stageMacosBackend({ ...options, output: root })).rejects.toThrow();
      expect(await NodeFSP.readFile(NodePath.join(root, "keep"), "utf8")).toBe("original");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked output parent leading into the source checkout", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-stage-alias-"));
    try {
      const sourceRoot = NodePath.join(root, "source");
      await NodeFSP.mkdir(sourceRoot);
      await NodeFSP.symlink(sourceRoot, NodePath.join(root, "alias"), "dir");
      await expect(
        stageMacosBackend({
          ...options,
          sourceRoot,
          output: NodePath.join(root, "alias/candidate"),
        }),
      ).rejects.toThrow("outside the source checkout");
      await expect(NodeFSP.stat(NodePath.join(sourceRoot, "candidate"))).rejects.toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses mismatched source before staging dependencies or stamping a pin", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-stage-pin-"));
    try {
      const sourceRoot = NodePath.join(root, "source");
      await NodeFSP.mkdir(sourceRoot);
      NodeChildProcess.execFileSync("git", ["init", "--quiet", sourceRoot]);
      let invoked = false;
      const output = NodePath.join(root, "candidate");
      await expect(
        stageMacosBackend(
          { ...options, sourceRoot, output },
          {
            stageDependencies: async () => {
              invoked = true;
            },
          },
        ),
      ).rejects.toThrow();
      expect(invoked).toBe(false);
      await expect(NodeFSP.stat(NodePath.join(output, ".t3-source-commit"))).rejects.toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("copies only a pinned bundle and stamps it after runtime staging succeeds", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-stage-bundle-"));
    try {
      const sourceRoot = NodePath.join(root, "source");
      await NodeFSP.mkdir(NodePath.join(sourceRoot, "apps/server/dist/client"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(sourceRoot, "apps/server/package.json"),
        '{"version":"0.1.7"}',
      );
      await NodeFSP.writeFile(
        NodePath.join(sourceRoot, "apps/server/dist/bin.mjs"),
        "// synthetic bundle",
      );
      await NodeFSP.writeFile(
        NodePath.join(sourceRoot, "apps/server/dist/client/index.html"),
        "synthetic client",
      );
      NodeChildProcess.execFileSync("git", ["init", "--quiet", sourceRoot]);
      NodeChildProcess.execFileSync("git", ["-C", sourceRoot, "add", "."]);
      NodeChildProcess.execFileSync("git", [
        "-C",
        sourceRoot,
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Synthetic fixture",
      ]);
      const pin = NodeChildProcess.execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const output = NodePath.join(root, "candidate");
      let invoked = false;
      await stageMacosBackend(
        { sourceRoot, output, commit: pin, arch: "arm64" },
        {
          stageDependencies: async () => {
            invoked = true;
          },
          host: () => ({ platform: "darwin", arch: "arm64", node: "24.18.0" }),
        },
      );
      expect(invoked).toBe(true);
      expect(await NodeFSP.readFile(NodePath.join(output, "dist/bin.mjs"), "utf8")).toBe(
        "// synthetic bundle",
      );
      expect(await NodeFSP.readFile(NodePath.join(output, ".t3-source-commit"), "utf8")).toBe(
        `${pin}\n`,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
