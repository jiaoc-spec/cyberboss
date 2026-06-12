#!/usr/bin/env node
const { readConfig } = require("../src/core/config");
const { ObsidianTrackerSyncService } = require("../src/services/obsidian-tracker-sync-service");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig();
  const service = new ObsidianTrackerSyncService({ config });
  const result = service.sync({
    throughDate: args.throughDate || args.date || "",
    days: args.days ? Number(args.days) : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--date" || item === "--through-date") {
      result.throughDate = argv[index + 1] || "";
      index += 1;
    } else if (item === "--days") {
      result.days = argv[index + 1] || "";
      index += 1;
    }
  }
  return result;
}

main();
