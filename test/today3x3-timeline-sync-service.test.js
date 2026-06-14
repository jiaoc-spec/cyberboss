const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  Today3x3TimelineSyncService,
  classify3x3Title,
  collectDropEventIds,
  mergeIntervals,
  scheduleRowsToTimelineEvents,
} = require("../src/services/today3x3-timeline-sync-service");

test("3x3 phone rows are unioned so overlapping devices count once", () => {
  const events = scheduleRowsToTimelineEvents([
    {
      id: 1,
      title: "📱刷手机",
      startAt: new Date("2026-06-14T10:00:00+02:00"),
      endAt: new Date("2026-06-14T10:30:00+02:00"),
    },
    {
      id: 2,
      title: "📱刷手机",
      startAt: new Date("2026-06-14T10:15:00+02:00"),
      endAt: new Date("2026-06-14T10:40:00+02:00"),
    },
  ], {
    date: "2026-06-14",
    timeZone: "Europe/Berlin",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].title, "刷手机 / 屏幕时间");
  assert.equal(events[0].startAt, "2026-06-14T10:00:00+02:00");
  assert.equal(events[0].endAt, "2026-06-14T10:40:00+02:00");
  assert.match(events[0].note, /40 分钟/);
  assert.match(events[0].note, /sourceRows=1,2/);
});

test("3x3 sync drops prior 3x3 events and Apple Calendar phone duplicates only", () => {
  const dropIds = collectDropEventIds([
    { id: "3x3-phone-old", tags: ["3x3", "phone"] },
    { id: "cal-phone", tags: ["apple-calendar", "phone"] },
    { id: "cal-screen", tags: ["apple-calendar", "screen-time"] },
    { id: "cal-work", tags: ["apple-calendar", "work"] },
    { id: "manual-note", tags: ["manual", "phone"] },
  ]);

  assert.deepEqual(dropIds, ["3x3-phone-old", "cal-phone", "cal-screen"]);
});

test("3x3 sync does not drop incoming events when rerun", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "today3x3-sync-"));
  const dbPath = path.join(tmpDir, "Model_3x3.sqlite");
  fs.writeFileSync(dbPath, "");
  const rows = [
    {
      id: 12,
      title: "英语发音",
      startAt: new Date("2026-06-14T10:00:00+02:00"),
      endAt: new Date("2026-06-14T10:25:00+02:00"),
    },
  ];
  const incoming = scheduleRowsToTimelineEvents(rows, {
    date: "2026-06-14",
    timeZone: "Europe/Berlin",
  });
  const writes = [];
  const sync = new Today3x3TimelineSyncService({
    config: {
      today3x3DatabasePath: dbPath,
      timeZone: "Europe/Berlin",
    },
    timeline: {
      async read() {
        return {
          data: {
            events: [
              { id: incoming[0].id, tags: ["3x3", "today-3x3"] },
              { id: "3x3-stale", tags: ["3x3", "today-3x3"] },
              { id: "cal-phone", tags: ["apple-calendar", "phone"] },
            ],
          },
        };
      },
      async write(payload) {
        writes.push(payload);
        return {};
      },
    },
  });
  sync.readRowsForDate = () => rows;

  await sync.sync({ start: "2026-06-14", end: "2026-06-14" });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].dropEventIds, ["3x3-stale", "cal-phone"]);
  assert.equal(writes[0].events[0].id, incoming[0].id);
});

test("3x3 title classification maps study and phone records", () => {
  assert.equal(classify3x3Title("英语发音 Rachel").kind, "study");
  assert.equal(classify3x3Title("Deutsch Grammatik").kind, "study");
  assert.equal(classify3x3Title("📱刷手机").kind, "phone");
});

test("3x3 sub-second fragments are skipped before timeline write", () => {
  const events = scheduleRowsToTimelineEvents([
    {
      id: 1,
      title: "📱刷手机",
      startAt: new Date("2026-06-14T10:00:00.100+02:00"),
      endAt: new Date("2026-06-14T10:00:00.500+02:00"),
    },
    {
      id: 2,
      title: "英语发音",
      startAt: new Date("2026-06-14T10:01:00+02:00"),
      endAt: new Date("2026-06-14T10:02:00+02:00"),
    },
  ], {
    date: "2026-06-14",
    timeZone: "Europe/Berlin",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].title, "英语发音");
});

test("3x3 events crossing midnight are clipped inside the target day", () => {
  const events = scheduleRowsToTimelineEvents([
    {
      id: 1,
      title: "📱刷手机",
      startAt: new Date("2026-06-14T23:50:00+02:00"),
      endAt: new Date("2026-06-15T00:10:00+02:00"),
    },
  ], {
    date: "2026-06-14",
    timeZone: "Europe/Berlin",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].startAt, "2026-06-14T23:50:00+02:00");
  assert.equal(events[0].endAt, "2026-06-14T23:59:59+02:00");
});

test("mergeIntervals keeps non-overlapping phone sessions separate", () => {
  const intervals = mergeIntervals([
    {
      startAt: new Date("2026-06-14T10:00:00+02:00"),
      endAt: new Date("2026-06-14T10:10:00+02:00"),
      sourceIds: [1],
    },
    {
      startAt: new Date("2026-06-14T10:10:00+02:00"),
      endAt: new Date("2026-06-14T10:20:00+02:00"),
      sourceIds: [2],
    },
    {
      startAt: new Date("2026-06-14T11:00:00+02:00"),
      endAt: new Date("2026-06-14T11:10:00+02:00"),
      sourceIds: [3],
    },
  ]);

  assert.equal(intervals.length, 2);
  assert.deepEqual(intervals[0].sourceIds, [1, 2]);
  assert.deepEqual(intervals[1].sourceIds, [3]);
});
