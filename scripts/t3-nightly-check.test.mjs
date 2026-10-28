import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./t3-nightly-check.mjs", import.meta.url));

for (const gate of ["format", "lint", "agent-context"]) {
  test(`real checker classifies synthetic ${gate} failure`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-check-fixture-"));
    try {
      const vp = path.join(root, "node_modules/vite-plus/bin/vp");
      fs.mkdirSync(path.dirname(vp), { recursive: true });
      fs.writeFileSync(path.join(root, "example.ts"), "export const value = 1;\n");
      fs.writeFileSync(path.join(root, "files.json"), JSON.stringify(["example.ts"]));
      fs.writeFileSync(vp, `
const args = process.argv.slice(2);
const name = args[0] === 'fmt' ? 'format' : args[0] === 'lint' ? 'lint' : args[1] === 'run' ? 'agent-context' : args[0];
if (name === ${JSON.stringify(gate)}) { console.error('example.ts: synthetic ${gate} failure'); process.exitCode = 1; }
`);
      const artifact = path.join(root, "artifact");
      const result = spawnSync(process.execPath, [checker, root, artifact, path.join(root, "files.json")], { encoding: "utf8" });
      assert.equal(result.status, 1, result.stderr);
      const check = JSON.parse(fs.readFileSync(path.join(artifact, "checks.json"), "utf8")).find((item) => item.name === gate);
      assert.equal(check.exit, 1);
      assert.equal(check.classified, true);
      assert.ok(check.failures.length > 0);
      assert.match(JSON.stringify(check.failures), /synthetic/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a missing vp executable remains unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-check-missing-"));
  try {
    fs.writeFileSync(path.join(root, "files.json"), "[]");
    const artifact = path.join(root, "artifact");
    const result = spawnSync(process.execPath, [checker, root, artifact, path.join(root, "files.json")]);
    assert.equal(result.status, 1);
    const checks = JSON.parse(fs.readFileSync(path.join(artifact, "checks.json"), "utf8"));
    for (const check of checks) {
      assert.equal(check.classified, false);
      assert.deepEqual(check.failures, []);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
