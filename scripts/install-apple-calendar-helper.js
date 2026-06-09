#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const home = os.homedir();
const appName = "CyberBoss Calendar Helper";
const bundleId = "com.jiaoc.cyberboss.calendar-helper";
const appDir = path.join(home, "Applications", `${appName}.app`);
const contentsDir = path.join(appDir, "Contents");
const executableDir = path.join(contentsDir, "MacOS");
const executableFile = path.join(executableDir, "CyberBossCalendarHelper");
const sourceFile = path.resolve(__dirname, "apple-calendar-helper.swift");
const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
const launchAgentFile = path.join(launchAgentsDir, `${bundleId}.plist`);
const logDir = path.join(home, ".cyberboss", "logs");

function main() {
  fs.mkdirSync(executableDir, { recursive: true });
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  run("/usr/bin/swiftc", [
    sourceFile,
    "-parse-as-library",
    "-framework", "AppKit",
    "-framework", "EventKit",
    "-framework", "Foundation",
    "-o", executableFile,
  ]);
  fs.writeFileSync(path.join(contentsDir, "Info.plist"), infoPlist(), "utf8");
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appDir]);
  fs.writeFileSync(launchAgentFile, launchAgentPlist(), "utf8");

  const domain = `gui/${process.getuid()}`;
  spawnSync("/bin/launchctl", ["bootout", domain, launchAgentFile], { stdio: "ignore" });
  run("/bin/launchctl", ["bootstrap", domain, launchAgentFile]);
  run("/bin/launchctl", ["kickstart", "-k", `${domain}/${bundleId}`]);

  console.log(`Installed: ${appDir}`);
  console.log(`LaunchAgent: ${launchAgentFile}`);
  console.log(`Cache: ${path.join(home, ".cyberboss", "apple-calendar-cache.json")}`);
  console.log("If macOS asks for Calendar access, choose Allow Full Access.");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>CyberBossCalendarHelper</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>CyberBoss needs calendar access to prepare your timeline and daily review.</string>
  <key>NSCalendarsUsageDescription</key>
  <string>CyberBoss needs calendar access to prepare your timeline and daily review.</string>
</dict>
</plist>
`;
}

function launchAgentPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${bundleId}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executableFile}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, "calendar-helper.out.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, "calendar-helper.err.log")}</string>
</dict>
</plist>
`;
}

main();
