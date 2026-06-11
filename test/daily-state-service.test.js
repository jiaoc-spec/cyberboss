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

test("daily state reads high shift fatigue and recommends minimum mode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-daily-state-shift-"));
  const shiftRatingStateFile = path.join(dir, "shift-rating-state.json");
  fs.writeFileSync(shiftRatingStateFile, `${JSON.stringify({
    lastPromptBySender: {
      "telegram:jane": {
        date: "2026-06-06",
        text: "夜班结束了",
        promptedAt: "2026-06-06T07:32:00+02:00",
        answeredAt: "2026-06-06T07:35:00+02:00",
        answerText: "8分",
        score: 8,
        fatigueBand: "high",
      },
    },
  })}\n`);
  const service = new DailyStateService({
    config: { timeZone: "Europe/Berlin", shiftRatingStateFile },
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
    now: new Date("2026-06-06T20:00:00+02:00"),
  });

  assert.equal(state.shiftRating.score, 8);
  assert.equal(state.shiftRating.fatigueBand, "high");
  assert.equal(state.signals.highAfterShiftFatigue, true);
  assert.equal(state.recommendedMode, "minimum");
});

test("daily state schedules context questions by shift type and blocks active classes", async () => {
  const service = new DailyStateService({
    config: { timeZone: "Europe/Berlin" },
    dailyInbox: {
      read() {
        return {
          exists: true,
          filePath: "/tmp/2026-06-10.md",
          text: "### 05:13\n> 待会儿早班\n### 16:01\n> 我现在在上今天下午的网课，16:00到19:30",
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
        return {
          events: [
            {
              title: "Blickpunkt Wunde",
              start: "2026-06-10T16:00:00+02:00",
              end: "2026-06-10T19:30:00+02:00",
              calendar: "Arbeit",
            },
          ],
        };
      },
    },
  });

  const duringClass = await service.analyze({
    date: "2026-06-10",
    now: new Date("2026-06-10T18:05:00+02:00"),
  });
  assert.equal(duringClass.signals.hasEarlyShift, true);
  assert.equal(duringClass.contextQuestionTiming.baseDueAt, "18:00");
  assert.equal(duringClass.contextQuestionTiming.dueAt, "19:45");
  assert.equal(duringClass.contextQuestionTiming.isDue, false);
  assert.equal(duringClass.temporalContext.currentEvent.title, "Blickpunkt Wunde");

  const afterClass = await service.analyze({
    date: "2026-06-10",
    now: new Date("2026-06-10T19:46:00+02:00"),
  });
  assert.equal(afterClass.contextQuestionTiming.isDue, true);
});

test("daily state uses late-shift and night-shift question windows", async () => {
  const create = (text) => new DailyStateService({
    config: { timeZone: "Europe/Berlin" },
    dailyInbox: { read: () => ({ exists: true, filePath: "/tmp/day.md", text }) },
    timeline: { async read() { return { data: { events: [] } }; } },
    calendar: { async read() { return { events: [] }; } },
  });

  const late = await create("今天晚班").analyze({
    date: "2026-06-10",
    now: new Date("2026-06-10T22:30:00+02:00"),
  });
  assert.equal(late.contextQuestionTiming.dueAt, "23:00");
  assert.equal(late.contextQuestionTiming.isDue, false);

  const lateDue = await create("今天晚班").analyze({
    date: "2026-06-10",
    now: new Date("2026-06-10T23:01:00+02:00"),
  });
  assert.equal(lateDue.contextQuestionTiming.isDue, true);

  const night = await create("今天夜班").analyze({
    date: "2026-06-10",
    now: new Date("2026-06-10T20:01:00+02:00"),
  });
  assert.equal(night.contextQuestionTiming.dueAt, "20:00");
  assert.equal(night.contextQuestionTiming.isDue, true);
});
