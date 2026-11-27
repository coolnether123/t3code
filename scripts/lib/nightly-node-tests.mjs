import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeUtil from "node:util";

// Preserve runner errors separately from assertion failures. A file with no
// assertions or a failed process must never qualify as an inherited failure.
export async function runNodeSuites(files) {
  const suites = [];
  for (const file of files) {
    const suite = { name: file, status: "passed", assertionResults: [] };
    const names = [];
    let finished = false;
    for await (const { type, data } of NodeTest.run({ files: [file], execArgv: [] })) {
      if (type === "test:summary" && !data.file) {
        finished = true;
        if (!data.success) suite.status = "failed";
      }
      if (type === "test:start") names[data.nesting] = data.name;
      if (type !== "test:pass" && type !== "test:fail") continue;
      const failed = type === "test:fail" && !data.todo && !data.skip;
      if (failed) suite.status = "failed";
      const error = data.details.error;
      if (NodePath.resolve(data.name) === file || data.details.type === "suite") {
        if (failed && error?.failureType !== "subtestsFailed") {
          throw new Error(`Node suite failed outside its assertions: ${file}`, { cause: error });
        }
        continue;
      }
      suite.assertionResults.push({
        fullName: [...names.slice(0, data.nesting), data.name].join(" "),
        status: failed ? "failed" : data.todo ? "todo" : data.skip ? "pending" : "passed",
        failureMessages: error ? [NodeUtil.inspect(error, { depth: null, colors: false })] : [],
      });
    }
    if (!finished || !suite.assertionResults.length) {
      throw new Error(`Node did not complete any assertions for ${file}`);
    }
    suites.push(suite);
  }
  return suites;
}
