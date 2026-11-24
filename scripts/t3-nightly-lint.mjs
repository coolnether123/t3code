import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";

import { checkFileBatches } from "./lib/check-file-batches.ts";

export function newLintDiagnostics(candidate, baseline) {
  const key = (d) =>
    JSON.stringify([d.filename.replaceAll("\\", "/"), d.code, d.severity, d.message]);
  const remaining = new Map();
  for (const diagnostic of baseline) {
    const id = key(diagnostic);
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  return candidate.filter((diagnostic) => {
    const id = key(diagnostic);
    const count = remaining.get(id) ?? 0;
    if (count === 0) return true;
    remaining.set(id, count - 1);
    return false;
  });
}

export function lintAgainstBase(root, files, base, artifact) {
  const vp = NodePath.join(root, "node_modules/vite-plus/bin/vp");
  const execute = (command, args, cwd) => {
    const result = NodeChildProcess.spawnSync(command, args, {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return result;
  };
  const lint = (cwd, name) => {
    const existing = files.filter((file) => NodeFS.existsSync(NodePath.join(cwd, file)));
    if (existing.length === 0) return [];
    const diagnostics = [];
    for (const [index, batch] of checkFileBatches(existing).entries()) {
      const result = execute(
        process.execPath,
        [
          vp,
          "lint",
          "--no-error-on-unmatched-pattern",
          "--format=json",
          "--report-unused-disable-directives",
          ...batch,
        ],
        cwd,
      );
      const prefix = NodePath.join(artifact, `${name}-${index + 1}`);
      NodeFS.writeFileSync(`${prefix}.json`, result.stdout);
      NodeFS.writeFileSync(`${prefix}.stderr.log`, result.stderr);
      // Oxlint prefixes its JSON with this notice when the entire batch is ignored.
      const json = result.stdout.replace(
        /^No files found to lint\. Please check your paths and ignore patterns\.\r?\n/,
        "",
      );
      const data = JSON.parse(json);
      if (!Array.isArray(data.diagnostics) || (result.status !== 0 && !data.diagnostics.length)) {
        throw new Error(`Unclassified lint failure in ${prefix}, exit ${result.status}`);
      }
      diagnostics.push(...data.diagnostics);
    }
    return diagnostics;
  };
  const candidate = lint(root, "lint-candidate");
  if (!candidate.length) return { inherited: 0, failures: [] };
  if (!base) return { inherited: 0, failures: candidate };
  const tree = NodePath.resolve(
    NodePath.dirname(root),
    `t3-lint-baseline-${NodeCrypto.randomUUID()}`,
  );
  if (NodePath.dirname(tree) !== NodePath.dirname(NodePath.resolve(root)))
    throw new Error("Unsafe lint baseline path");
  const add = execute(
    "git",
    ["-c", "core.longpaths=true", "worktree", "add", "--detach", tree, base],
    root,
  );
  if (add.status !== 0) throw new Error(`Cannot create lint baseline: ${add.stderr}`);
  const linkedModules = [];
  const cleanup = () => {
    for (const modules of linkedModules) NodeFS.unlinkSync(modules);
    const removed = execute("git", ["worktree", "remove", tree], root);
    if (removed.status !== 0) throw new Error(`Cannot clean lint baseline: ${removed.stderr}`);
  };
  try {
    for (const relative of ["node_modules", "oxlint-plugin-t3code/node_modules"]) {
      const source = NodePath.join(root, relative);
      if (!NodeFS.existsSync(source)) continue;
      const target = NodePath.join(tree, relative);
      NodeFS.symlinkSync(source, target, "junction");
      linkedModules.push(target);
    }
    const baseline = lint(tree, "lint-baseline");
    const failures = newLintDiagnostics(candidate, baseline);
    return { inherited: candidate.length - failures.length, failures };
  } finally {
    cleanup();
  }
}
