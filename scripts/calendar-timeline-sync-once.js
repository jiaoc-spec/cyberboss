#!/usr/bin/env node
require("dotenv").config();

const { readConfig } = require("../src/core/config");
const { createTimelineIntegration } = require("../src/integrations/timeline");
const { CalendarService } = require("../src/services/calendar-service");
const { CalendarTimelineSyncService } = require("../src/services/calendar-timeline-sync-service");
const { TimelineService } = require("../src/services/timeline-service");

async function main() {
  const config = readConfig();
  const calendar = new CalendarService({ config });
  const timeline = new TimelineService({
    config,
    channelAdapter: {
      resolveAccount: () => ({ accountId: "manual-calendar-sync" }),
      getKnownContextTokens: () => ({}),
    },
    timelineIntegration: createTimelineIntegration(config),
    sessionStore: null,
  });
  const sync = new CalendarTimelineSyncService({ config, calendar, timeline });
  const result = await sync.sync({
    days: Number(process.argv[2]) || config.calendarTimelineSyncDays || 2,
  });
  console.log(JSON.stringify({
    authorization: result.authorization,
    imported: result.imported.length,
    skipped: result.skipped,
    events: result.imported.map((event) => ({
      title: event.title,
      startAt: event.startAt,
      endAt: event.endAt,
      subcategoryId: event.subcategoryId,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
