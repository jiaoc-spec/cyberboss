#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const home = os.homedir();
const rootDir = path.resolve(__dirname, "..");
const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(home, ".cyberboss");
const logDir = path.join(stateDir, "logs");
const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
const label = "com.jiaoc.cyberboss.bridge";
const launchAgentFile = path.join(launchAgentsDir, `${label}.plist`);
const stdoutFile = path.join(logDir, "launch-agent.out.log");
const stderrFile = path.join(logDir, "launch-agent.err.log");
const nodeFile = process.execPath;
const codexFile = findCommand("codex");

function main() {
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(launchAgentFile, launchAgentPlist(), "utf8");

  const domain = `gui/${process.getuid()}`;
  spawnSync("/bin/launchctl", ["bootout", domain, launchAgentFile], { stdio: "ignore" });
  run("/bin/launchctl", ["bootstrap", domain, launchAgentFile]);
  run("/bin/launchctl", ["kickstart", "-k", `${domain}/${label}`]);

  console.log(`Installed: ${launchAgentFile}`);
  console.log(`Logs: ${stdoutFile}`);
  console.log(`Errors: ${stderrFile}`);
}

function findCommand(command) {
  const result = spawnSync("/usr/bin/which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function launchAgentPlist() {
  const pathEntries = [
    path.dirname(nodeFile),
    codexFile ? path.dirname(codexFile) : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean);
  const environment = [
    `    <key>PATH</key>\n    <string>${escapeXml(Array.from(new Set(pathEntries)).join(":"))}</string>`,
    codexFile
      ? `    <key>CYBERBOSS_CODEX_COMMAND</key>\n    <string>${escapeXml(codexFile)}</string>`
      : "",
  ].filter(Boolean).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeFile)}</string>
    <string>${escapeXml(path.join(rootDir, "scripts", "shared-start.js"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(rootDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrFile)}</string>
</dict>
</plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

main();
