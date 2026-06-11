#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const JS_ROOTS = ["src", "scripts"];
const SWIFT_FILES = [
  "scripts/apple-calendar-read.swift",
  "scripts/apple-calendar-helper.swift",
];

function collectJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...collectJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

let failures = 0;

const jsFiles = JS_ROOTS.flatMap((root) => collectJsFiles(path.join(repoRoot, root)));
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failures += 1;
    console.error(`✗ ${path.relative(repoRoot, file)}`);
    console.error(result.stderr.trim());
  }
}

for (const swiftFile of SWIFT_FILES) {
  const fullPath = path.join(repoRoot, swiftFile);
  if (!fs.existsSync(fullPath)) continue;
  const result = spawnSync("swift", ["-frontend", "-parse", fullPath], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    console.warn(`⚠ swift not available, skipped ${swiftFile}`);
    continue;
  }
  if (result.status !== 0) {
    failures += 1;
    console.error(`✗ ${swiftFile}`);
    console.error(result.stderr.trim());
  }
}

if (failures > 0) {
  console.error(`\ncheck failed: ${failures} file(s) with syntax errors`);
  process.exit(1);
}
console.log(`check ok: ${jsFiles.length} js files + swift parse`);
