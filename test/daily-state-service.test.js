const test = require("node:test");
const assert = require("node:assert/strict");

const { DailyStateService } = require("../src/services/daily-state-service");

test("daily state detects night shift boundary and minimum mode", async () => {
  const service = new DailyStateService({
    config: {
      timeZone: "Europe/Berlin",
      criticalHabitsLevelAHour: 20,
      criticalHabitsNightShiftLeadMinutes: 180,
    },
    dailyInbox: {
      read() {
        return {
          exists: true,
          filePath: "/tmp/2026-06-05.md",
          text: "### 13:10\n> 我醒了，但是夜班后还是很累。",
        };
      },
    },
    timeline: {
      async read() {
        return {
          data: {
            events: [
              { title: "25分钟英语学习", categoryId: "study.language", tags: ["英语"] },
              { title: "夜班后睡眠", categoryId: "rest.sleep" },
            ],
          },
        };
      },
    },
    calendar: {
      async read() {
        return {
          events: [
            {
              title: "夜班",
              start: "2026-06-05T21:30:00+02:00",
              end: "2026-06-06T07:00:00+02:00",
              calendar: "Work",
            },
          ],
        };
      },
    },
  });

  const state = await service.analyze({
    date: "2026-06-05",
    now: new Date("2026-06-05T18:35:00+02:00"),
  });

  assert.equal(state.signals.hasNightShift, true);
  assert.equal(state.recommendedMode, "minimum");
  assert.equal(state.priorityTiming.isDue, true);
  assert.equal(state.priorityTiming.dueAt, "15:00");
  assert.equal(state.levelA.find((item) => item.id === "english").completed, true);
  assert.equal(state.levelA.find((item) => item.id === "sport").completed, false);
});
