import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { runMacNightly, validateMacConfig } from "./t3-nightly-macos.mjs";
import { nightlyPlist } from "./register-t3-nightly-macos.mjs";

const base = "1".repeat(40);
const candidate = "2".repeat(40);
const host = (user) => ({
  home: `/Users/${user}`,
  hostname: "fixture",
  environmentId: "fixture",
  sourceRoot: `/Users/${user}/source`,
  baseDir: `/Users/${user}/.t3`,
  node: "/node",
  wsRequireFrom: "/ws/package.json",
  nativeSocket: "/native.sock",
  backupRoot: `/Users/${user}/backups`,
  listenerAddresses: ["127.0.0.1:3773"],
});

async function scenario(kind) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-nightly-fixture-"));
  const config = {
    platform: "darwin",
    repository: "/Users/christinesmith/Developer/t3code",
    branch: "christine/t3-3669-mac-20261028",
    artifactRoot: "/Users/christinesmith/.local/share/t3-nightly-test",
    node: "/node",
    stagingNode: "/stage-node",
    vp: "/vp",
    stopRoot: "/Users/christinesmith/Codex_Workroom/task_evidence/otis-control",
    focusedTests: ["scripts/deploy-macos-backend.test.ts"],
    ...(kind === "prepare" ? { maintenanceMode: "prepare-only" } : {}),
    elora: host("christinesmith"),
    millie: { ...host("millie"), ssh: "millie-codex" },
  };
  validateMacConfig(config);
  const commands = [];
  let head = base;
  let merging = false;
  let captures = 0;
  let unresolved = false;
  const persistedSwaps = [];
  const installed = { elora: base, millie: kind === "current-partial" ? "0".repeat(40) : base };
  const run = (exe, args, cwd, env) => {
    commands.push([exe, args, cwd, env]);
    const ok = (text = "") => ({ code: 0, text });
    if (exe === "git") {
      if (args[0] === "remote")
        return ok(
          args[2] === "nas"
            ? "millie-codex:/Volumes/Photos/Otis_Git_Backups/elora-t3code.git"
            : `https://github.com/${args[2] === "origin" ? "coolnether123" : "pingdotgg"}/t3code.git`,
        );
      if (args[0] === "branch") return ok(config.branch);
      if (args[0] === "status") return ok("");
      if (args[0] === "rev-parse") {
        if (args.includes("--show-toplevel")) return ok(config.repository);
        if (args.includes("MERGE_HEAD"))
          return { code: merging ? 0 : 1, text: merging ? "3".repeat(40) : "" };
        return ok(args.at(-1) === "refs/remotes/upstream/main" ? "3".repeat(40) : head);
      }
      if (args[0] === "merge-base") return { code: kind.startsWith("current") ? 0 : 1, text: "" };
      if (args[0] === "merge") {
        if (args[1] === "--abort") {
          merging = false;
          unresolved = false;
          return ok();
        }
        merging = true;
        unresolved = kind.startsWith("conflict");
        return { code: unresolved || kind === "merge-error" ? 1 : 0, text: "" };
      }
      if (args[0] === "diff" && args.includes("--diff-filter=U"))
        return ok(unresolved ? "apps/server/src/example.ts\0" : "");
      if (args[0] === "add") {
        unresolved = false;
        return ok();
      }
      if (args[0] === "commit") {
        merging = false;
        head = candidate;
        return ok();
      }
      if (args[0] === "reset") {
        head = base;
        return ok();
      }
      if (args[0] === "push") {
        const failed =
          (kind === "nas" && args.includes("--dry-run")) ||
          (kind === "publish" && !args.includes("--dry-run") && args[1] === "nas") ||
          (kind === "origin" && args[1] === "origin");
        return { code: failed ? 1 : 0, text: "" };
      }
      return ok();
    }
    if (exe === "/vp" && args[0] === "check" && ["gate", "conflict-gate"].includes(kind))
      return { code: 1, text: "" };
    if (
      (exe === "/usr/bin/python3" && args[3] === "installed") ||
      (exe === "/usr/bin/ssh" && args.at(-1).includes("'installed'"))
    )
      return ok(
        JSON.stringify({ commitPrefix: installed[exe === "/usr/bin/ssh" ? "millie" : "elora"] }),
      );
    if (
      (exe === "/usr/bin/python3" && args[3] === "deploy") ||
      (exe === "/usr/bin/ssh" && args.at(-1).includes("'deploy'"))
    ) {
      const name = exe === "/usr/bin/ssh" ? "millie" : "elora";
      const artifactRoot = NodePath.join(directory, "artifacts");
      const runDirectory = NodeFS.readdirSync(artifactRoot).find((name) => name.startsWith("run-"));
      persistedSwaps.push(
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(artifactRoot, runDirectory, "result.json"), "utf8"),
        ),
      );
      if (kind === "partial" && name === "millie") return { code: 1, text: "unknown install" };
      if (kind === "unknown" && name === "elora") return { code: 1, text: "unknown install" };
      installed[name] = head;
      if (kind === "peer" && name === "millie")
        return ok(JSON.stringify({ peerRecoveryRequired: true }));
      return ok(
        JSON.stringify({
          commitPrefix: head,
          maintenanceHold: kind === "retirement",
          recovery: { verified: kind !== "recovery-unverified", resumed: 1, held: 1 },
        }),
      );
    }
    if (exe === "/usr/bin/ssh" && args.at(-1).includes("'accept-recovered'"))
      return ok(
        JSON.stringify({
          commitPrefix: head,
          maintenanceHold: false,
          recovery: { verified: true, resumed: 1, held: 1 },
        }),
      );
    if (
      (exe === "/usr/bin/python3" && args[3] === "capture") ||
      (exe === "/usr/bin/ssh" && args.at(-1).includes("'capture'"))
    ) {
      captures++;
      if ((kind === "busy" && captures === 2) || (kind === "late-busy" && captures === 6))
        return { code: 1, text: "" };
      return ok(
        JSON.stringify({
          admitted: true,
          activeRuns: kind === "preview-active" ? 1 : 0,
          pendingApprovals: kind === "preview-active" ? 1 : 0,
          childAgents: kind === "preview-active" ? 1 : 0,
        }),
      );
    }
    return ok();
  };
  try {
    const result = await runMacNightly(config, {
      run,
      preview: kind === "preview-active",
      artifactRoot: NodePath.join(directory, "artifacts"),
      stopRoot: directory,
      stage: async () => {},
      launchResolver: async () => {
        commands.push(["resolver", []]);
        return { code: kind === "conflict" ? 1 : 0, safeToRecover: kind !== "conflict-live" };
      },
    });
    return { result, commands, head, merging, persistedSwaps };
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

NodeTest.test("nightly refuses a clone, missing focused tests and arbitrary remote route", () => {
  NodeAssert.throws(() => validateMacConfig({ repository: "/tmp/clone" }));
});

NodeTest.test(
  "active preview admits work without merge, install, resume or history mutation",
  async () => {
    const { result, commands, head } = await scenario("preview-active");
    NodeAssert.equal(result.result, "previewed");
    NodeAssert.equal(head, base);
    NodeAssert.deepEqual(result.liveChanges, []);
    for (const name of ["elora", "millie"])
      NodeAssert.deepEqual(result.admission[name], {
        admitted: true,
        activeRuns: 1,
        pendingApprovals: 1,
        childAgents: 1,
      });
    for (const operation of ["fetch", "push", "merge", "commit", "maintenance", "deploy", "note"])
      NodeAssert.equal(
        commands.some(
          ([, args]) => args.includes(operation) || args.at(-1)?.includes?.("'" + operation + "'"),
        ),
        false,
        operation,
      );
  },
);

NodeTest.test("an installed marker without recovery proof retains an uncertain swap", async () => {
  const { result, commands, head } = await scenario("recovery-unverified");
  NodeAssert.equal(result.result, "held");
  NodeAssert.equal(head, candidate);
  NodeAssert.equal(result.swaps.elora.phase, "attempting");
  NodeAssert.equal(
    commands.some(([, args]) => args[0] === "reset"),
    false,
  );
  NodeAssert.equal(
    commands.some(([, args]) => args.at(-1)?.includes?.("'cleanup'")),
    false,
  );
});

NodeTest.test(
  "prepare-only builds and publishes without live-host idle checks or install",
  async () => {
    const { result, commands } = await scenario("prepare");
    NodeAssert.equal(result.result, "prepared");
    NodeAssert.deepEqual(result.liveChanges, []);
    for (const operation of ["capture", "installed", "maintenance", "prepare", "deploy"])
      NodeAssert.equal(
        commands.some(
          ([, args]) => args.includes(operation) || args.at(-1)?.includes?.("'" + operation + "'"),
        ),
        false,
      );
    NodeAssert.ok(commands.some(([, args]) => args.includes("--build-only")));
    NodeAssert.ok(commands.some(([, args]) => args[0] === "push" && args[1] === "nas"));
  },
);

for (const kind of [
  "busy",
  "conflict",
  "conflict-gate",
  "merge-error",
  "gate",
  "nas",
  "publish",
  "late-busy",
]) {
  NodeTest.test(
    `nightly ${kind} leaves live installations alone and restores owned source`,
    async () => {
      const { result, commands, head, merging } = await scenario(kind);
      NodeAssert.equal(result.result, "held");
      NodeAssert.equal(head, base);
      NodeAssert.equal(merging, false);
      NodeAssert.deepEqual(result.liveChanges, []);
      NodeAssert.equal(
        commands.filter(([exe, args]) => exe === "/usr/bin/python3" && args[3] === "note").length,
        1,
      );
      NodeAssert.equal(
        commands.some(([, args]) => args.includes("deploy") || args.at(-1)?.includes?.("'deploy'")),
        false,
      );
      NodeAssert.equal(
        commands.some(([, args]) => args.includes("--hard") || args.includes("--no-verify")),
        false,
      );
    },
  );
}

NodeTest.test("conflict resolver returns to normal gates and guarded installs once", async () => {
  const { result, commands } = await scenario("conflict-repaired");
  NodeAssert.equal(result.result, "deployed");
  NodeAssert.equal(commands.filter(([exe]) => exe === "resolver").length, 1);
  NodeAssert.ok(
    commands.findIndex(([exe]) => exe === "resolver") <
      commands.findIndex(([exe, args]) => exe === "/vp" && args[0] === "install"),
  );
  NodeAssert.equal(
    commands.filter(([exe, args]) => exe === "/usr/bin/python3" && args[3] === "note").length,
    1,
  );
});

NodeTest.test(
  "uncertain resolver exit never aborts or installs under a possibly live writer",
  async () => {
    const { result, commands } = await scenario("conflict-live");
    NodeAssert.equal(result.result, "held");
    NodeAssert.equal(result.sourceRecoveryRequired, true);
    NodeAssert.equal(
      commands.some(([, args]) => args[0] === "merge" && args[1] === "--abort"),
      false,
    );
    NodeAssert.equal(
      commands.some(([, args]) => args.includes("deploy")),
      false,
    );
  },
);

NodeTest.test(
  "nightly deploys only after strict gates, NAS publication and both-host rechecks",
  async () => {
    for (const kind of ["green", "origin"]) {
      const { result, commands, head } = await scenario(kind);
      NodeAssert.equal(result.result, "deployed");
      NodeAssert.equal(head, candidate);
      NodeAssert.deepEqual(result.liveChanges, ["elora", "millie"]);
      NodeAssert.equal(result.originPublished, kind !== "origin");
      for (const [, , cwd, env] of commands.filter(([exe]) => exe === "git")) {
        NodeAssert.equal(env?.GIT_OPTIONAL_LOCKS, "0");
        NodeAssert.equal(cwd, "/Users/christinesmith/Developer/t3code");
      }
      const commit = commands.find(([, args]) => args[0] === "commit")[1];
      NodeAssert.equal(commit.at(-1).match(/Otis-Task:/g).length, 1);
      NodeAssert.ok(
        commands.some(([, args]) => args.includes("check:changed") && args.includes(base)),
      );
      NodeAssert.ok(commands.some(([, args]) => args[0] === "--test"));
      NodeAssert.equal(
        commands.filter(([, args]) => args[0] === "push" && args[1] === "origin").length,
        1,
      );
    }
  },
);

NodeTest.test(
  "nightly hands off an installed peer collision once without reinstalling",
  async () => {
    const { result, commands } = await scenario("peer");
    NodeAssert.equal(result.result, "deployed");
    NodeAssert.deepEqual(result.liveChanges, ["elora", "millie"]);
    NodeAssert.equal(
      commands.filter(([exe, args]) => exe === "/usr/bin/ssh" && args.at(-1).includes("'deploy'"))
        .length,
      1,
    );
    NodeAssert.equal(
      commands.filter(
        ([, args]) =>
          args.some((arg) => String(arg).endsWith("macos-peer-handoff.py")) &&
          args.includes("coordinate"),
      ).length,
      1,
    );
  },
);

NodeTest.test("already-current nightly never merges, builds or deploys", async () => {
  const { result, commands } = await scenario("current");
  NodeAssert.equal(result.result, "already-current");
  NodeAssert.equal(
    commands.some(([, args]) => args[0] === "merge" || args.includes("--build-only")),
    false,
  );
});

NodeTest.test("current source resumes only the verified missing Mac", async () => {
  const { result, commands, head } = await scenario("current-partial");
  NodeAssert.equal(result.result, "deployed");
  NodeAssert.equal(head, base);
  NodeAssert.deepEqual(result.liveChanges, ["millie"]);
  NodeAssert.equal(
    commands.some(([, args]) => args[0] === "commit"),
    false,
  );
  NodeAssert.equal(
    commands.some(([exe, args]) => exe === "/usr/bin/python3" && args[3] === "deploy"),
    false,
  );
});

NodeTest.test(
  "partial or unknown attempted installations never reset source or claim no change",
  async () => {
    for (const kind of ["partial", "unknown", "retirement"]) {
      const { result, commands, head, persistedSwaps } = await scenario(kind);
      NodeAssert.equal(head, candidate);
      NodeAssert.equal(persistedSwaps[0].swaps.elora.phase, "attempting");
      if (kind === "partial") {
        NodeAssert.equal(persistedSwaps[1].swaps.elora.phase, "accepted");
        NodeAssert.equal(persistedSwaps[1].swaps.millie.phase, "attempting");
      }
      NodeAssert.equal(
        commands.some(([, args]) => args[0] === "reset"),
        false,
      );
      if (kind === "retirement") NodeAssert.equal(result.retirementHolds.length, 2);
      else NodeAssert.equal(result.result, "held");
    }
  },
);

NodeTest.test("launchd uses the canonical controller at 03:30 without a model or RunAtLoad", () => {
  const text = nightlyPlist(
    {
      repository: "/Users/christinesmith/Developer/t3code",
      node: "/node",
      vp: "/vp",
      artifactRoot: "/private",
    },
    "/private/config.json",
  );
  NodeAssert.match(text, /<integer>3<\/integer>.*<integer>30<\/integer>/s);
  NodeAssert.match(
    text,
    /\/Users\/christinesmith\/Developer\/t3code\/scripts\/t3-nightly-macos-lock\.py/,
  );
  NodeAssert.doesNotMatch(text, /RunAtLoad|codex exec|claude|speak|say/);
});
