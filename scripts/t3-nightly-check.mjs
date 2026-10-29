import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { lintAgainstBase } from "./t3-nightly-lint.mjs";
const [root, artifact, filesJson, lintBase] = process.argv.slice(2);
NodeFS.mkdirSync(artifact, { recursive: true });
const vp = NodePath.join(root, "node_modules/vite-plus/bin/vp");
const files = JSON.parse(NodeFS.readFileSync(filesJson, "utf8"));
const results = [];
const sourceFiles = files.filter(
  (f) => /\.[cm]?[jt]sx?$/.test(f) && NodeFS.existsSync(NodePath.join(root, f)),
);
for (const [name, args] of [
  ["format", ["fmt", "--check", ...sourceFiles]],
  ["lint", []],
  [
    "agent-context",
    [
      "test",
      "run",
      "apps/server/src/provider/AgentContextBudget.test.ts",
      "evals/mcp-tool-use/run.test.ts",
      "--maxWorkers=1",
      "--reporter=dot",
    ],
  ],
  [
    "typecheck",
    ["run", "-r", "--cache", "--concurrency-limit", "1", "typecheck", "--singleThreaded"],
  ],
  [
    "tests",
    [
      "test",
      "related",
      "--run",
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${NodePath.join(artifact, "tests.json")}`,
      ...sourceFiles,
    ],
  ],
]) {
  if (["format", "lint", "tests"].includes(name) && sourceFiles.length === 0) {
    results.push({
      name,
      exit: 0,
      failures: [],
      classified: true,
      skipped: "No changed source files",
    });
    continue;
  }
  if (name === "lint") {
    try {
      const lint = lintAgainstBase(root, sourceFiles, lintBase, artifact);
      NodeFS.writeFileSync(NodePath.join(artifact, "lint-new.json"), JSON.stringify(lint, null, 2));
      results.push({
        name,
        exit: lint.failures.length ? 1 : 0,
        failures: lint.failures.map((d) => JSON.stringify(d)).sort(),
        classified: true,
        inherited: lint.inherited,
        baseline: lintBase ?? null,
      });
    } catch (error) {
      NodeFS.writeFileSync(NodePath.join(artifact, "lint.log"), String(error));
      results.push({ name, exit: 1, failures: [], classified: false });
    }
    continue;
  }
  const log = NodeFS.openSync(NodePath.join(artifact, `${name}.log`), "w");
  const result = NodeChildProcess.spawnSync(process.execPath, [vp, ...args], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PATH: `${NodePath.dirname(process.execPath)};${process.env.PATH}` },
  });
  NodeFS.closeSync(log);
  const text = NodeUtil.stripVTControlCharacters(
    NodeFS.readFileSync(NodePath.join(artifact, `${name}.log`), "utf8"),
  ).replaceAll(root, "<root>");
  const failures =
    name === "typecheck"
      ? text
          .split(/\r?\n/)
          .filter((l) => /error TS\d+/.test(l))
          .sort()
      : name === "tests" && NodeFS.existsSync(NodePath.join(artifact, "tests.json"))
        ? JSON.parse(NodeFS.readFileSync(NodePath.join(artifact, "tests.json"), "utf8"))
            .testResults.flatMap((s) =>
              s.assertionResults
                .filter((t) => t.status === "failed")
                .map(
                  (t) =>
                    `${NodePath.relative(root, s.name)}:${t.fullName}:${t.failureMessages.join("\n").replaceAll(root, "<root>")}`,
                ),
            )
            .sort()
        : [];
  results.push({
    name,
    exit: result.status,
    failures,
    classified: result.status === 0 || failures.length > 0,
  });
}
NodeFS.writeFileSync(NodePath.join(artifact, "checks.json"), JSON.stringify(results, null, 2));
process.exitCode = results.every((r) => r.exit === 0) ? 0 : 1;
