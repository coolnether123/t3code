import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { physicalDirectory } from "./t3-release-state.mjs";

const sha = /^[a-f0-9]{40}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const key = (path) => NodePath.resolve(path).toLowerCase();
const same = (left, right) =>
  typeof left === "string" && typeof right === "string" && key(left) === key(right);
const inside = (root, path) => {
  const directory = key(root);
  const candidate = key(path);
  const prefix = directory.endsWith(NodePath.sep) ? directory : directory + NodePath.sep;
  return candidate !== directory && candidate.startsWith(prefix);
};
const overlaps = (left, right) => same(left, right) || inside(left, right) || inside(right, left);

function stat(path) {
  try {
    return NodeFS.lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function readEvidence(path) {
  const info = stat(path);
  if (!info) return null;
  if (!info.isFile() || info.nlink !== 1) throw new Error("Evidence file is not physical");
  return JSON.parse(NodeFS.readFileSync(path, "utf8"));
}

function verifyTree(root, dir = root, build = false) {
  for (const name of NodeFS.readdirSync(dir)) {
    const path = NodePath.join(dir, name);
    const info = NodeFS.lstatSync(path);
    if (info.isSymbolicLink()) {
      // Prepared pnpm trees contain relative dependency links. Only unlink those entries.
      if (build && NodePath.relative(root, path).split(NodePath.sep).includes("node_modules")) {
        const target = NodeFS.readlinkSync(path);
        if (!NodePath.isAbsolute(target) && inside(root, NodePath.resolve(dir, target))) continue;
      }
      throw new Error("Tree contains a link");
    }
    if (info.isDirectory()) verifyTree(root, path, build);
    else if (!info.isFile() || (!build && info.nlink !== 1))
      throw new Error("Tree contains a non-owned file");
  }
}

function verifySnapshot(config, path, receipt) {
  if (!physicalDirectory(path)) throw new Error("Snapshot directory is missing");
  const manifest = readEvidence(NodePath.join(path, "snapshot.json"));
  if (
    manifest?.id !== receipt.id ||
    !same(manifest.source, config.baseDir) ||
    manifest.offline !== true ||
    (receipt.backup !== undefined && !same(receipt.backup, path))
  )
    throw new Error("Offline snapshot identity mismatch");
  const rolledBack = receipt.result === "rolled-back";
  const contents = rolledBack
    ? "restore-state.json,snapshot.json,userdata"
    : "snapshot.json,userdata";
  if (NodeFS.readdirSync(path).sort().join(",") !== contents)
    throw new Error("Unexpected snapshot contents");
  const userdata = NodePath.join(path, "userdata");
  if (!physicalDirectory(userdata)) throw new Error("Missing offline userdata");
  const restore = rolledBack ? readEvidence(NodePath.join(path, "restore-state.json")) : null;
  if (
    rolledBack &&
    (restore?.version !== 1 ||
      restore.phase !== "complete" ||
      !same(restore.source, userdata) ||
      typeof restore.data !== "string" ||
      !NodePath.isAbsolute(restore.data) ||
      NodePath.basename(restore.data) !== "userdata" ||
      !["staged", "failed"].every((field) => {
        const prefix = restore.data + (field === "staged" ? ".restore-" : ".failed-");
        return (
          typeof restore[field] === "string" &&
          restore[field].startsWith(prefix) &&
          uuid.test(restore[field].slice(prefix.length))
        );
      }))
  )
    throw new Error("No complete offline restore journal for the rollback");
  verifyTree(path);
  const databases = ["statev2.sqlite", "state.sqlite"];
  const database = databases.map((name) => NodePath.join(userdata, name)).find(stat);
  if (!database || !stat(database)?.isFile()) throw new Error("Missing offline SQLite database");
  const header = Buffer.alloc(16);
  const fd = NodeFS.openSync(database, "r");
  try {
    if (NodeFS.readSync(fd, header, 0, 16, 0) !== 16 || header.toString() !== "SQLite format 3\0")
      throw new Error("Invalid offline SQLite header");
  } finally {
    NodeFS.closeSync(fd);
  }
  if (!restore) return null;
  const { version, source, data, staged, failed, phase } = restore;
  return { version, source, data, staged, failed, phase };
}

function readDeployHistory(root, names, isRelease) {
  const history = new Map();
  for (const name of names) {
    const id = name.match(/^receipt-(.+)\.json$/)?.[1];
    if (!uuid.test(id ?? "")) continue;
    try {
      const value = readEvidence(NodePath.join(root, name));
      const started = Date.parse(value?.startedAt);
      const finished = Date.parse(value?.finishedAt);
      if (
        value?.id === id &&
        isRelease(value.candidate) &&
        value.commit === NodePath.basename(value.candidate) &&
        isRelease(value.previous) &&
        Number.isFinite(started) &&
        Number.isFinite(finished) &&
        started <= finished
      )
        history.set(id, {
          value,
          started,
          finished,
          healthy:
            value.result === "healthy" &&
            value.checks?.ok === true &&
            value.rollback === null &&
            !stat(NodePath.join(root, `recovery-${id}.json`)),
        });
    } catch {
      // Unreadable evidence cannot establish ownership or count as a restore point.
    }
  }
  return history;
}

function snapshotPlan(config, roots, history, latest) {
  const plan = { keep: [], eligible: [], held: [], deleted: [], restoreEvidence: [] };
  const entries = new Map();
  for (const root of roots) {
    for (const name of NodeFS.readdirSync(root)) {
      const id = name.toLowerCase();
      if (!entries.has(id)) entries.set(id, []);
      entries.get(id).push(NodePath.join(root, name));
    }
  }
  const verified = [];
  for (const [id, paths] of entries) {
    const attempt = history.get(id);
    let reason;
    if (paths.length !== 1) reason = "Snapshot ID occurs in multiple entries";
    else if (attempt?.value.result === "rollback-failed") reason = "Rollback failed";
    else if (!attempt) reason = "No matching terminal deployment receipt";
    else if (
      !attempt.healthy &&
      !(
        attempt.value.result === "rolled-back" &&
        attempt.value.rollback?.ok === true &&
        attempt.value.rollback.checks?.ok === true &&
        !stat(NodePath.join(config.releaseRoot, `recovery-${id}.json`))
      )
    )
      reason = "No verified deployment or completed rollback";
    else if (
      attempt.finished > latest.finished ||
      (attempt.finished === latest.finished && attempt !== latest)
    )
      reason = "Receipt is unordered relative to the serving release";
    else {
      try {
        const restore = verifySnapshot(config, paths[0], attempt.value);
        verified.push({ ...attempt, path: paths[0], restore });
      } catch (error) {
        reason = error.message;
      }
    }
    if (reason) for (const path of paths) plan.held.push({ path, reason });
  }
  const healthy = verified.filter((entry) => entry.healthy).sort((a, b) => b.finished - a.finished);
  const finishedCounts = new Map();
  for (const entry of healthy)
    finishedCounts.set(entry.finished, (finishedCounts.get(entry.finished) ?? 0) + 1);
  const newest = healthy.filter((entry) => finishedCounts.get(entry.finished) === 1).slice(0, 2);
  for (const entry of verified) {
    if (newest.includes(entry)) plan.keep.push(entry.path);
    else if (finishedCounts.get(entry.finished) > 1)
      plan.held.push({
        path: entry.path,
        reason: "Healthy receipts have the same completion time",
      });
    else if (newest.length === 2 && newest.every((point) => point.started > entry.finished)) {
      plan.eligible.push(entry.path);
      if (entry.restore) plan.restoreEvidence.push({ id: entry.value.id, journal: entry.restore });
    } else
      plan.held.push({ path: entry.path, reason: "Fewer than two newer verified restore points" });
  }
  return plan;
}

export async function retainDeployment(config, state, options, attestOwners, save, recordPlan) {
  const { dryRun = false, retireRelease } = options;
  const root = NodePath.resolve(config.releaseRoot);
  const isRelease = (path) =>
    typeof path === "string" &&
    NodePath.isAbsolute(path) &&
    same(NodePath.dirname(path), root) &&
    sha.test(NodePath.basename(path));
  if (!physicalDirectory(root)) throw new Error("Missing physical release root");
  if (
    state.version !== 1 ||
    !Array.isArray(state.good) ||
    state.good.length < 1 ||
    state.good.length > 3 ||
    !same(state.current, state.good[0]) ||
    !state.good.every(isRelease) ||
    new Set(state.good.map(key)).size !== state.good.length
  )
    throw new Error("Invalid release state for retention");
  await attestOwners(state.current);

  const names = NodeFS.readdirSync(root);
  const history = readDeployHistory(root, names, isRelease);
  const last = readEvidence(NodePath.join(root, "last-deploy.json"));
  const latest = history.get(last?.id);
  if (
    !latest?.healthy ||
    !same(last.candidate, state.current) ||
    last.result !== "healthy" ||
    last.finishedAt !== latest.value.finishedAt ||
    !same(last.previous, latest.value.previous) ||
    !same(last.candidate, latest.value.candidate) ||
    !(same(last.previous, state.current) || same(last.previous, state.good[1]))
  )
    throw new Error("Retention requires a terminal healthy receipt for the serving release");

  const protectedPaths = [
    config.baseDir,
    config.artifactRoot,
    config.supervisorScript,
    config.node,
  ].filter(Boolean);
  const legacy = NodePath.join(root, "data-backups");
  if (!NodePath.isAbsolute(config.backupRoot) || !NodePath.isAbsolute(config.baseDir))
    throw new Error("Retention requires absolute configured data paths");
  const backup = NodePath.resolve(config.backupRoot);
  if (
    (!same(backup, legacy) && overlaps(backup, root)) ||
    protectedPaths.some((path) => overlaps(path, backup) || overlaps(path, legacy))
  )
    throw new Error("Backup roots overlap protected deployment paths");
  const roots = (same(backup, legacy) ? [backup] : [backup, legacy]).filter(physicalDirectory);
  const snapshots = snapshotPlan(config, roots, history, latest);

  const requested = retireRelease === undefined ? null : NodePath.join(root, retireRelease);
  if (
    requested &&
    (!sha.test(retireRelease) ||
      state.good.slice(0, 2).some((path) => same(path, requested)) ||
      (state.good.length === 3 && !same(state.good[2], requested)))
  )
    throw new Error("Specify the full SHA of the third good release");
  const releases = { eligible: [], held: [], deleted: [] };
  const keep = state.good.filter((path) => !same(path, requested));
  for (const name of names) {
    if (!sha.test(name)) continue;
    const path = NodePath.join(root, name);
    if (keep.some((value) => same(value, path)) || (requested && !same(requested, path))) continue;
    try {
      if (protectedPaths.some((value) => overlaps(value, path)))
        throw new Error("Release overlaps a protected path");
      if (!physicalDirectory(path)) throw new Error("Missing release directory");
      const prepared = readEvidence(NodePath.join(path, "release.json"));
      const preparedAt = Date.parse(prepared?.preparedAt);
      const attempts = [...history.values()].filter((attempt) =>
        same(attempt.value.candidate, path),
      );
      const deployed = attempts.sort((a, b) => b.finished - a.finished)[0];
      if (
        prepared?.commit !== name ||
        !same(prepared.root, path) ||
        prepared.liveDataUsed !== false ||
        !Number.isFinite(preparedAt) ||
        !deployed?.healthy ||
        preparedAt > deployed.started ||
        deployed.finished >= latest.finished ||
        attempts[1]?.finished === deployed.finished
      )
        throw new Error("No matching historical healthy deployment for this prepared release");
      verifyTree(path, path, true);
      releases.eligible.push(path);
    } catch (error) {
      releases.held.push({ path, reason: error.message });
    }
  }

  const retire = requested && releases.eligible.some((path) => same(path, requested));
  const ok =
    !requested ||
    Boolean(retire) ||
    (state.good.length < 3 &&
      !stat(requested) &&
      [...history.values()].some(
        (entry) => entry.healthy && same(entry.value.candidate, requested),
      ));
  if (!ok && releases.held.length === 0)
    releases.held.push({
      path: requested,
      reason: "Requested release is missing verified deployment evidence",
    });
  if (dryRun || !ok) return { ok, releases, snapshots };
  recordPlan({ ok, releases, snapshots, phase: "planned" });
  if (retire && state.good.length === 3) {
    // Close supervisor start admission before checking for requests already accepted.
    save({ ...state, good: keep });
    try {
      await attestOwners(state.current);
    } catch (error) {
      save(state);
      throw error;
    }
  }
  for (const plan of [releases, snapshots]) {
    for (const path of plan.eligible) {
      try {
        NodeFS.rmSync(path, { recursive: true });
        plan.deleted.push(path);
      } catch (error) {
        plan.held.push({ path, reason: `Removal failed: ${error.code ?? error.message}` });
      }
    }
  }
  return {
    ok: [releases, snapshots].every((plan) => plan.eligible.length === plan.deleted.length),
    releases,
    snapshots,
  };
}
