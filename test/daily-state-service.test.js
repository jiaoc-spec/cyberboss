const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

test("daily state treats current night shift wording as active work", async () => {
  const service = new DailyStateService({
    config: { timeZone: "Europe/Berlin" },
    dailyInbox: {
      read() {
        return {
          exists: true,
          filePath: "/tmp/2026-06-06.md",
          text: "### 01:46\n> 我在上夜班，怎么睡觉",
        };
      },
    },
    timeline: {
      async read() {
        return { data: { events: [] } };
      },
    },
    calendar: {
      async read() {
        return { events: [] };
      },
    },
  });

  const state = await service.analyze({
    date: "2026-06-06",
    now: new Date("2026-06-06T01:48:00+02:00"),
  });

  assert.equal(state.signals.currentlyWorking, true);
});

test("daily state includes missing context answers as structured evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-daily-state-missing-"));
  const missingContextStateFile = path.join(dir, "missing-context-state.json");
  fs.writeFileSync(missingContextStateFile, `${JSON.stringify({
    days: {
      "2026-06-06": {
        fields: {
          reason_for_missing_level_a: {
            field: "reason_for_missing_level_a",
            value: "fatigue",
            label: "太累",
            answeredAt: "2026-06-06T20:06:00+02:00",
          },
        },
        questions: [{ id: "q1", status: "answered" }],
      },
    },
  })}\n`);
  const service = new DailyStateService({
    config: { timeZone: "Europe/Berlin", missingContextStateFile },
    dailyInbox: {
      read() {
        return { exists: true, filePath: "/tmp/2026-06-06.md", text: "" };
      },
    },
    timeline: {
      async read() {
        return { data: { events: [] } };
      },
    },
    calendar: {
      async read() {
        return { events: [] };
      },
    },
  });

  const state = await service.analyze({
    date: "2026-06-06",
    now: new Date("2026-06-06T21:00:00+02:00"),
  });

  assert.equal(state.sources.missingContextQuestions, 1);
  assert.equal(state.missingContext.fields.reason_for_missing_level_a.value, "fatigue");
});
