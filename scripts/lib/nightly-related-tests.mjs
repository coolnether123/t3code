import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// The controller runs outside the checkout. Use the candidate's own test runner and config.
const requireFromCandidate = NodeModule.createRequire(NodePath.resolve("package.json"));
const runner = NodeURL.pathToFileURL(requireFromCandidate.resolve("vite-plus/test/node"));
const { startVitest } = await import(runner.href);
const [manifest, outputFile] = process.argv.slice(2);
const related = JSON.parse(NodeFS.readFileSync(manifest, "utf8"));
const context = await startVitest([], {
  related,
  run: true,
  watch: false,
  maxWorkers: 1,
  reporters: ["json"],
  outputFile,
});
await context.exit();
