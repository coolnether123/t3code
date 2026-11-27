import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { runNodeSuites } from "./nightly-node-tests.mjs";

// The controller runs outside the checkout. Use the candidate's own test runner and config.
const requireFromCandidate = NodeModule.createRequire(NodePath.resolve("package.json"));
const runner = NodeURL.pathToFileURL(requireFromCandidate.resolve("vite-plus/test/node"));
const { createVitest } = await import(runner.href);
const { parseSync } = requireFromCandidate("vite-plus");

function declaresNodeTest(file, source) {
  if (!source.includes("node:test")) return false;
  const parsed = parseSync(file, source);
  if (parsed.errors.length) throw new Error(`Cannot identify test runner for ${file}`);
  const requiresNodeTest = (call) =>
    call?.type === "CallExpression" &&
    call.callee.type === "Identifier" &&
    call.callee.name === "require" &&
    call.arguments[0]?.value === "node:test";
  return parsed.program.body.some((statement) => {
    if (statement.type === "ImportDeclaration") {
      return statement.importKind !== "type" && statement.source.value === "node:test";
    }
    if (statement.type === "ExpressionStatement") return requiresNodeTest(statement.expression);
    return (
      statement.type === "VariableDeclaration" &&
      statement.declarations.some((declaration) => requiresNodeTest(declaration.init))
    );
  });
}
const [manifest, outputFile] = process.argv.slice(2);
const related = JSON.parse(NodeFS.readFileSync(manifest, "utf8"));
const vitestReport = outputFile + ".vitest.json";
const context = await createVitest({
  related,
  run: true,
  watch: false,
  maxWorkers: 1,
  reporters: ["json"],
  outputFile: vitestReport,
});
try {
  const specs = await context.getRelevantTestSpecifications([]);
  const native = new Set();
  const vite = new Set();
  for (const spec of specs) {
    const file = NodePath.resolve(spec.moduleId);
    const source = NodeFS.readFileSync(file, "utf8");
    (declaresNodeTest(file, source) ? native : vite).add(file);
  }
  if (!specs.length) throw new Error("No related test suites were selected");
  const nodeResults = await runNodeSuites([...native]);
  NodeFS.writeFileSync(outputFile + ".node.json", JSON.stringify(nodeResults));
  let viteResults = [];
  let unhandledErrors = [];
  if (vite.size) {
    await context.start([...vite]);
    unhandledErrors = context.state.getUnhandledErrors().map((error) => ({
      name: error.name,
      message: error.message,
      stack: error.stack,
      VITEST_TEST_PATH: error.VITEST_TEST_PATH,
      VITEST_TEST_NAME: error.VITEST_TEST_NAME,
    }));
    viteResults = JSON.parse(NodeFS.readFileSync(vitestReport, "utf8")).testResults;
    const reported = new Set(viteResults.map((suite) => NodePath.resolve(suite.name)));
    if (reported.size !== vite.size || [...vite].some((file) => !reported.has(file))) {
      throw new Error("Vitest did not report the selected suite list");
    }
  }
  const testResults = [...viteResults, ...nodeResults];
  const assertions = testResults.flatMap((suite) => suite.assertionResults);
  const count = (status) => assertions.filter((test) => test.status === status).length;
  const success =
    unhandledErrors.length === 0 && testResults.every((suite) => suite.status !== "failed");
  if (!success) process.exitCode = 1;
  if (success && process.exitCode) throw new Error("A runner failed outside its reported suites");
  NodeFS.writeFileSync(
    outputFile,
    JSON.stringify({
      success,
      unhandledErrors,
      testResults,
      numTotalTests: assertions.length,
      numPassedTests: count("passed"),
      numFailedTests: count("failed"),
      numPendingTests: count("pending") + count("skipped"),
      numTodoTests: count("todo"),
    }),
  );
} finally {
  await context.exit();
}
