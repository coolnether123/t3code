import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

export function restoreOfflineUserdata(source, target, rename = NodeFS.renameSync) {
  const data = NodeFS.realpathSync(target);
  source = NodeFS.realpathSync(source);
  const journalPath = NodePath.join(NodePath.dirname(source), "restore-state.json");
  const state = NodeFS.existsSync(journalPath)
    ? JSON.parse(NodeFS.readFileSync(journalPath, "utf8"))
    : {
        version: 1,
        source,
        data,
        staged: data + ".restore-" + NodeCrypto.randomUUID(),
        failed: data + ".failed-" + NodeCrypto.randomUUID(),
        phase: "staging",
      };
  if (
    state.version !== 1 ||
    state.source !== source ||
    state.data !== data ||
    !["staging", "evacuating", "installing", "complete"].includes(state.phase) ||
    !["staged", "failed"].every(
      (key) =>
        typeof state[key] === "string" && NodePath.dirname(state[key]) === NodePath.dirname(data),
    ) ||
    !state.staged.startsWith(data + ".restore-") ||
    !state.failed.startsWith(data + ".failed-")
  ) {
    throw new Error("Offline restore journal identity mismatch");
  }
  const save = () => {
    const temporary = journalPath + "." + NodeCrypto.randomUUID() + ".tmp";
    const fd = NodeFS.openSync(temporary, "wx");
    try {
      NodeFS.writeFileSync(fd, JSON.stringify(state));
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
    NodeFS.renameSync(temporary, journalPath);
  };
  save();
  const { staged, failed } = state;
  if (state.phase === "staging") {
    NodeFS.cpSync(source, staged, {
      recursive: true,
      filter: (entry) => NodePath.relative(source, entry).split(NodePath.sep)[0] !== "logs",
    });
    NodeFS.mkdirSync(failed, { recursive: true });
    state.phase = "evacuating";
    save();
  }
  // Otis holds the logs directory open; preserve it and the userdata junction during offline recovery.
  if (state.phase === "evacuating") {
    for (const entry of NodeFS.readdirSync(data)) {
      if (entry !== "logs") rename(NodePath.join(data, entry), NodePath.join(failed, entry));
    }
    state.phase = "installing";
    save();
  }
  if (state.phase === "installing") {
    if (NodeFS.existsSync(staged)) {
      for (const entry of NodeFS.readdirSync(staged))
        rename(NodePath.join(staged, entry), NodePath.join(data, entry));
      NodeFS.rmdirSync(staged);
    }
    state.phase = "complete";
    save();
  }
  return { preserved: failed };
}
