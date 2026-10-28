import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export function installCliForwarder(configPath, target, backupRoot) {
  const source = `import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const config=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8'));
const root=fs.realpathSync(config.releaseRoot);
const state=JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8'));
const current=fs.realpathSync(state.current);
if(path.dirname(current).toLowerCase()!==root.toLowerCase()) throw new Error('Release is outside the release root');
const child=spawnSync(config.node,[path.join(current,'apps/server/dist/bin.mjs'),...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});
if(child.error) throw child.error;
process.exitCode=child.status??1;
`;
  NodeFS.mkdirSync(backupRoot, { recursive: true });
  const backup = NodePath.join(backupRoot, "relay-bin.mjs");
  if (!NodeFS.existsSync(backup))
    NodeFS.copyFileSync(target, backup, NodeFS.constants.COPYFILE_EXCL);
  const temporary = `${target}.forwarding.tmp`;
  NodeFS.writeFileSync(temporary, source, { flag: "wx" });
  NodeFS.renameSync(temporary, target);
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  installCliForwarder(...process.argv.slice(2));
}
