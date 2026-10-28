import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

export function restoreOfflineUserdata(source, target) {
  const data = NodeFS.realpathSync(target);
  const staged = data + ".restore-" + NodeCrypto.randomUUID();
  const failed = data + ".failed-" + NodeCrypto.randomUUID();
  NodeFS.cpSync(source, staged, {
    recursive: true,
    filter: (entry) => NodePath.relative(source, entry).split(NodePath.sep)[0] !== "logs",
  });
  NodeFS.mkdirSync(failed);
  // Otis holds the logs directory open; preserve it and the userdata junction during offline recovery.
  for (const entry of NodeFS.readdirSync(data)) {
    if (entry !== "logs")
      NodeFS.renameSync(NodePath.join(data, entry), NodePath.join(failed, entry));
  }
  for (const entry of NodeFS.readdirSync(staged))
    NodeFS.renameSync(NodePath.join(staged, entry), NodePath.join(data, entry));
  NodeFS.rmdirSync(staged);
  return { preserved: failed };
}
