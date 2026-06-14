#!/usr/bin/env node
require("dotenv").config();

const { readConfig } = require("../src/core/config");
const { createTimelineIntegration } = require("../src/integrations/timeline");
const { TimelineService } = require("../src/services/timeline-service");
const { Today3x3TimelineSyncService } = require("../src/services/today3x3-timeline-sync-service");

async function main() {
  const config = readConfig();
  const args = parseArgs(process.argv.slice(2));
  const timeline = new TimelineService({
    config,
    channelAdapter: {
      resolveAccount: () => ({ accountId: "manual-today3x3-sync" }),
      getKnownContextTokens: () => ({}),
    },
    timelineIntegration: createTimelineIntegration(config),
    sessionStore: null,
  });
  const sync = new Today3x3TimelineSyncService({ config, timeline });
  const result = await sync.sync({
    days: args.days || config.today3x3TimelineSyncDays || 2,
  });
  console.log(JSON.stringify({
    provider: result.provider,
    databasePath: result.databasePath,
    dates: result.dates || [],
    imported: result.imported?.length || 0,
    skipped: result.skipped || 0,
    reason: result.reason || "",
    byDate: summarizeByDate(result.imported || []),
    ...(args.verbose ? {
      events: (result.imported || []).map((event) => ({
        title: event.title,
        startAt: event.startAt,
        endAt: event.endAt,
        categoryId: event.categoryId,
        subcategoryId: event.subcategoryId,
      })),
    } : {}),
  }, null, 2));
}

function parseArgs(argv) {
  let days = 0;
  let verbose = false;
  for (const arg of argv) {
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    const parsed = Number(arg);
    if (Number.isFinite(parsed) && parsed > 0) {
      days = parsed;
    }
  }
  return { days, verbose };
}

function summarizeByDate(events) {
  const byDate = new Map();
  for (const event of events) {
    const date = String(event.startAt || "").slice(0, 10);
    if (!date) {
      continue;
    }
    const current = byDate.get(date) || { events: 0, phoneMinutes: 0 };
    current.events += 1;
    if (Array.isArray(event.tags) && event.tags.includes("phone")) {
      const minutes = (Date.parse(event.endAt) - Date.parse(event.startAt)) / 60_000;
      if (Number.isFinite(minutes) && minutes > 0) {
        current.phoneMinutes = Math.round((current.phoneMinutes + minutes) * 10) / 10;
      }
    }
    byDate.set(date, current);
  }
  return Object.fromEntries([...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
