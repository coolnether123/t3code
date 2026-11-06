import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { resolveNightlyConflict, launchResolver } from "./t3-nightly-resolver.mjs";

const upstream = "a".repeat(40);
const base = "b".repeat(40);

async function fixture(work) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-resolver-fixture-"));
  const directory = NodePath.join(root, "run");
  NodeFS.mkdirSync(directory, { mode: 0o700 });
  try {
    await work({
      root,
      directory,
      upstream,
      base,
      config: {
        repository: "/Users/christinesmith/Developer/t3code",
        branch: "christine/t3-3669-mac-20261028",
      },
      conflicts: ["apps/server/src/example.ts"],
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

NodeTest.test(
  "one durable reservation prevents concurrent and later retries for the same head",
  async () => {
    await fixture(async (input) => {
      let launches = 0;
      const launch = async (command) => {
        launches++;
        NodeAssert.equal(command.exe, "/bin/launchctl");
        NodeAssert.ok(command.args.includes("gpt-6.1-sol"));
        NodeAssert.ok(command.args.includes('model_reasoning_effort="high"'));
        NodeAssert.ok(command.args.includes("workspace-write"));
        NodeAssert.ok(command.args.includes("--ignore-user-config"));
        NodeAssert.ok(command.args.includes("--ephemeral"));
        NodeAssert.equal(
          command.args.includes("--dangerously-bypass-approvals-and-sandbox"),
          false,
        );
        NodeAssert.match(command.prompt, /Do not commit, publish, deploy/);
        NodeAssert.match(command.prompt, /parent wake/);
        return { code: 1, safeToRecover: true };
      };
      const io = { run: () => ({ code: 0, text: "" }), launch };
      const results = await Promise.all([
        resolveNightlyConflict(input, io),
        resolveNightlyConflict(input, io),
      ]);
      NodeAssert.equal(launches, 1);
      NodeAssert.equal(results.filter((item) => item.started).length, 1);
      NodeAssert.equal(results.find((item) => !item.started).safeToRecover, false);
      NodeAssert.equal((await resolveNightlyConflict(input, io)).status, "already-attempted");
      NodeAssert.equal(launches, 1);
      const records = NodeFS.readdirSync(NodePath.join(input.root, "resolver-heads"));
      NodeAssert.equal(records.length, 1);
      const record = JSON.parse(
        NodeFS.readFileSync(NodePath.join(input.root, "resolver-heads", records[0])),
      );
      NodeAssert.equal(record.status, "failed");
      NodeAssert.equal(record.upstream, upstream);
      NodeAssert.equal(record.model, "gpt-6.1-sol");
    });
  },
);

NodeTest.test(
  "a crash-partial ledger never permits a second model or automatic abort",
  async () => {
    await fixture(async (input) => {
      const ledgers = NodePath.join(input.root, "resolver-heads");
      NodeFS.mkdirSync(ledgers, { mode: 0o700 });
      NodeFS.writeFileSync(NodePath.join(ledgers, `${upstream}.json`), "{", { mode: 0o600 });
      const result = await resolveNightlyConflict(input);
      NodeAssert.equal(result.status, "already-attempted");
      NodeAssert.equal(result.safeToRecover, false);
    });
  },
);

NodeTest.test(
  "missing GUI and launch exceptions consume the claim without alternate routes",
  async () => {
    for (const mode of ["gui", "throw"])
      await fixture(async (input) => {
        let launches = 0;
        const io = {
          run: () => ({ code: mode === "gui" ? 1 : 0, text: "" }),
          launch: async () => {
            launches++;
            throw Error("launch failed");
          },
        };
        const result = await resolveNightlyConflict(input, io);
        NodeAssert.equal(result.started, mode !== "gui");
        NodeAssert.equal(result.status, "failed");
        NodeAssert.equal(launches, mode === "gui" ? 0 : 1);
        NodeAssert.equal((await resolveNightlyConflict(input, io)).status, "already-attempted");
      });
  },
);

NodeTest.test("an uncertain live resolver is retained as unsafe for source recovery", async () => {
  await fixture(async (input) => {
    const result = await resolveNightlyConflict(input, {
      run: () => ({ code: 0, text: "" }),
      launch: async () => ({ code: 1, safeToRecover: false, pid: 123 }),
    });
    NodeAssert.equal(result.safeToRecover, false);
    NodeAssert.equal(result.status, "failed");
  });
});

NodeTest.test("the ledger refuses a symlink and malformed source identities", async () => {
  await fixture(async (input) => {
    NodeFS.symlinkSync(input.directory, NodePath.join(input.root, "resolver-heads"));
    await NodeAssert.rejects(resolveNightlyConflict(input), /private/);
    await NodeAssert.rejects(resolveNightlyConflict({ ...input, upstream: "main" }), /identity/);
  });
});

NodeTest.test(
  "the owned subprocess exits without a chat and recording failure cancels only that group",
  async () => {
    for (const fail of [false, true])
      await fixture(async ({ directory }) => {
        let pid;
        const result = await launchResolver({
          exe: process.execPath,
          args: ["-e", "process.stdin.resume()"],
          prompt: "fixture",
          directory,
          repository: directory,
          env: process.env,
          onSpawn: (value) => {
            pid = value;
            if (fail) throw Error("disk failure");
          },
        });
        NodeAssert.ok(pid > 0);
        NodeAssert.equal(result.code, fail ? 1 : 0);
        NodeAssert.equal(result.safeToRecover, true);
      });
  },
);
