const test = require("node:test");
const assert = require("node:assert/strict");

const { calendarEventToTimelineEvents } = require("../src/services/calendar-timeline-sync-service");

test("calendar timeline sync splits overnight events by local date", () => {
  const events = calendarEventToTimelineEvents({
    id: "night-shift-1",
    title: "Nachtdienst",
    calendar: "Dienstplan",
    start: "2026-06-04T21:30:00+02:00",
    end: "2026-06-05T07:00:00+02:00",
    isAllDay: false,
  }, "Europe/Berlin");

  assert.equal(events.length, 2);
  assert.match(events[0].startAt, /^2026-06-04T21:30:00\+02:00$/);
  assert.match(events[0].endAt, /^2026-06-04T23:59:59\+02:00$/);
  assert.match(events[1].startAt, /^2026-06-05T00:00:00\+02:00$/);
  assert.match(events[1].endAt, /^2026-06-05T07:00:00\+02:00$/);
  assert.match(events[0].note, /跨午夜事件已按日期拆分/);
  assert.equal(events[0].title, "夜班 / Nachtdienst");
  assert.equal(events[0].categoryId, "work");
  assert.equal(events[0].subcategoryId, "work.other");
  assert.ok(events[0].tags.includes("night-shift"));
});
