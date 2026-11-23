import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { checkFileBatches } from "./lib/check-file-batches.ts";
import { lintAgainstBase } from "./t3-nightly-lint.mjs";

const [root, artifact, filesJson, lintBase] = process.argv.slice(2);
NodeFS.mkdirSync(artifact, { recursive: true });
const vp = NodePath.join(root, "node_modules/vite-plus/bin/vp");
const files = JSON.parse(NodeFS.readFileSync(filesJson, "utf8"));
const sourceFiles = files.filter(
  (f) => /\.[cm]?[jt]sx?$/.test(f) && NodeFS.existsSync(NodePath.join(root, f)),
);
const batches = checkFileBatches(sourceFiles);
const results = [];
for (const name of ["format", "lint", "agent-context", "typecheck", "tests"]) {
  if (["format", "lint", "tests"].includes(name) && batches.length === 0) {
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
  const logPath = NodePath.join(artifact, `${name}.log`);
  const log = NodeFS.openSync(logPath, "w");
  const failures = new Set();
  let exit = 0;
  let classified = true;
  let suiteCount = 0;
  const commands =
    name === "format"
      ? batches.map((batch) => ["fmt", "--check", "--no-error-on-unmatched-pattern", ...batch])
      : name === "tests"
        ? [
            [
              NodePath.join(import.meta.dirname, "lib/nightly-related-tests.mjs"),
              NodePath.resolve(artifact, "related-sources.json"),
              NodePath.resolve(artifact, "tests-1.json"),
            ],
          ]
        : name === "agent-context"
          ? [
              [
                "test",
                "run",
                "apps/server/src/provider/AgentContextBudget.test.ts",
                "evals/mcp-tool-use/run.test.ts",
                "--maxWorkers=1",
                "--reporter=dot",
              ],
            ]
          : [["run", "-r", "--cache", "--concurrency-limit", "1", "typecheck", "--singleThreaded"]];
  // Let Vitest traverse the changed sources together so shared suites run just once.
  if (name === "tests") {
    NodeFS.writeFileSync(
      NodePath.join(artifact, "related-sources.json"),
      JSON.stringify(sourceFiles),
    );
  }
  try {
    for (const [index, args] of commands.entries()) {
      const report = NodePath.join(artifact, `tests-${index + 1}.json`);
      if (name === "tests") NodeFS.rmSync(report, { force: true });
      NodeFS.writeSync(log, `\n${name} ${index + 1}/${commands.length}\n`);
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        name === "tests" ? args : [vp, ...args],
        {
          cwd: root,
          windowsHide: true,
          stdio: ["ignore", log, log],
          env: {
            ...process.env,
            PATH: `${NodePath.dirname(process.execPath)}${NodePath.delimiter}${process.env.PATH}`,
          },
        },
      );
      if (result.error || result.signal)
        NodeFS.writeSync(log, String(result.error ?? result.signal));
      if (result.status !== 0) exit = result.status ?? 1;
      if (name === "tests") {
        if (!NodeFS.existsSync(report)) {
          if (result.status !== 0) classified = false;
          continue;
        }
        const suites = JSON.parse(NodeFS.readFileSync(report, "utf8")).testResults;
        suiteCount += suites.length;
        let failedBatch = false;
        for (const suite of suites) {
          const failed = suite.assertionResults.filter((t) => t.status === "failed");
          if (suite.status === "failed" && !failed.length) classified = false;
          for (const test of failed) {
            failedBatch = true;
            failures.add(
              `${NodePath.relative(root, suite.name)}:${test.fullName}:${test.failureMessages.join("\n").replaceAll(root, "<root>")}`,
            );
          }
        }
        if (result.status !== 0 && !failedBatch) classified = false;
      }
    }
  } finally {
    NodeFS.closeSync(log);
  }
  if (name === "tests" && !suiteCount) {
    exit = 1;
    classified = false;
  }
  if (name === "typecheck" && exit !== 0) {
    const text = NodeUtil.stripVTControlCharacters(NodeFS.readFileSync(logPath, "utf8")).replaceAll(
      root,
      "<root>",
    );
    for (const line of text.split(/\r?\n/)) if (/error TS\d+/.test(line)) failures.add(line);
  }
  results.push({
    name,
    exit,
    failures: [...failures].sort(),
    classified: exit === 0 || (classified && failures.size > 0),
  });
}
NodeFS.writeFileSync(NodePath.join(artifact, "checks.json"), JSON.stringify(results, null, 2));
process.exitCode = results.every((r) => r.exit === 0) ? 0 : 1;
