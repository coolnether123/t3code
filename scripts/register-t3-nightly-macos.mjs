import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { nightlyLabel, validateMacConfig } from "./t3-nightly-macos.mjs";

const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function nightlyPlist(config, configPath) {
  const script = NodePath.join(config.repository, "scripts/t3-nightly-macos-lock.py");
  const log = NodePath.join(config.artifactRoot, "launchd.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${nightlyLabel}</string>
<key>ProgramArguments</key><array>${["/usr/bin/python3", script, configPath].map((arg) => `<string>${escape(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${escape(config.repository)}</string>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
<key>ProcessType</key><string>Background</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(`${NodePath.dirname(config.node)}:${NodePath.dirname(config.vp)}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string></dict>
<key>StandardOutPath</key><string>${escape(log)}</string>
<key>StandardErrorPath</key><string>${escape(log)}</string>
</dict></plist>\n`;
}

export function installMacNightly(configPath, execute = false) {
  if (!NodePath.isAbsolute(configPath)) throw Error("The private config path must be absolute.");
  const info = NodeFS.lstatSync(configPath);
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid() || info.mode & 0o077)
    throw Error("The config must be an owner-only regular file.");
  const config = validateMacConfig(JSON.parse(NodeFS.readFileSync(configPath, "utf8")));
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone installer must reject a different real host before loading launchd.
  const platform = process.platform;
  if (
    platform !== "darwin" ||
    NodeOS.userInfo().username !== "christinesmith" ||
    NodeOS.hostname() !== config.elora.hostname
  )
    throw Error("The nightly installer must run as Christine on verified Elora.");
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "America/New_York")
    throw Error("launchd must use Elora's America/New_York system timezone.");
  const folder = NodePath.join(NodeOS.homedir(), "Library/LaunchAgents");
  const plist = NodePath.join(folder, nightlyLabel + ".plist");
  const overlaps = NodeFS.readdirSync(folder).filter(
    (name) =>
      name.endsWith(".plist") &&
      name !== nightlyLabel + ".plist" &&
      /t3.*(?:night|latest-idle|upgrade)|(?:night|upgrade).*t3/i.test(name),
  );
  if (overlaps.length)
    throw Error("An existing T3 upgrade schedule must be retired before installing this job.");
  if (NodeFS.existsSync(plist))
    throw Error("The nightly schedule already exists; reconcile it before replacing it.");
  const next = new Date();
  next.setHours(3, 30, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  const plan = {
    label: nightlyLabel,
    firstRun: next.toISOString(),
    timezone: "America/New_York",
    plist,
    installed: false,
  };
  if (!execute) return plan;
  NodeFS.mkdirSync(config.artifactRoot, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(plist, nightlyPlist(config, configPath), { mode: 0o600, flag: "wx" });
  const result = NodeChildProcess.spawnSync(
    "/bin/launchctl",
    ["bootstrap", `gui/${process.getuid()}`, plist],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw Error(
      "The nightly schedule was written but launchd did not load it; inspect the exact job before retrying.",
    );
  return { ...plan, installed: true };
}

if (process.argv[1] === import.meta.filename) {
  try {
    console.log(
      JSON.stringify(installMacNightly(process.argv[2], process.argv.includes("--execute"))),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
