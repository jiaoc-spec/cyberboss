const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");
const { chooseStrategyCheckpoint } = require("../src/services/day-strategy-service");

test("telegram runtime context treats day operations plan as the canonical day type", async () => {
  const app = {
    config: { timeZone: "Europe/Berlin" },
    temporalContextCache: null,
    projectServices: {
      dailyState: {
        async analyze() {
          return {
            signals: { hasOffDay: true },
            temporalContext: {
              localNow: "2026-06-17 10:00",
              dayType: "off_day",
              scheduleMode: "off_day",
              currentEvent: null,
              scheduleEventsToday: [
                { title: "Weiterbildung zur PA", calendar: "Arbeit", start: "08:30", end: "15:00" },
              ],
              remainingEventsToday: [],
            },
          };
        },
      },
      dayOperationsPlanner: {
        async plan() {
          return {
            date: "2026-06-17",
            timeZone: "Europe/Berlin",
            scheduleMode: "course_day",
            dayType: "course_day",
            day_type: "course_day",
            fixedBlocks: [
              { label: "Weiterbildung zur PA", start: "08:30", end: "15:00" },
            ],
            priorityWindows: [],
            currentPhase: { kind: "do_not_disturb", reason: "course_calendar_block" },
            levelA: { open: [], completed: [] },
          };
        },
      },
      currentState: null,
    },
    async readTomorrowMorningCalendarContext() {
      return [];
    },
    buildDayOperationsPlanContext: CyberbossApp.prototype.buildDayOperationsPlanContext,
    buildCurrentStateContextLines() {
      return [];
    },
  };

  const text = await CyberbossApp.prototype.buildRuntimeTemporalContext.call(app, {
    receivedAt: "2026-06-17T10:00:00+02:00",
  });

  assert.match(text, /Canonical day type \(Day Operations Plan\): course_day/);
  assert.match(text, /Daily State schedule mode \(secondary evidence only\): off_day/);
  assert.match(text, /SOURCE OF TRUTH: Use the Day Operations Plan as the canonical day context/);
  assert.match(text, /HARD RULE: canonical day type is course_day \/ Weiterbildung/);
  assert.doesNotMatch(text, /today is an OFF day per her calendar/);
});

test("day strategy uses day operations plan over conflicting daily-state signals", () => {
  const strategy = chooseStrategyCheckpoint({
    analysis: {
      signals: { hasOffDay: true },
      temporalContext: {
        scheduleMode: "off_day",
        scheduleEventsToday: [
          { title: "Weiterbildung zur PA", calendar: "Arbeit", start: "08:30", end: "15:00" },
        ],
      },
      levelA: [{ id: "sport", label: "Sport", completed: false }],
      priorityTiming: { dueAtMinutes: 20 * 60 },
    },
    operationsPlan: {
      dayType: "course_day",
      scheduleMode: "course_day",
      currentPhase: { kind: "priority_window", reason: "after_course" },
    },
    campaignStatus: { upcomingDeadlines: [] },
    tomorrow: { workEvents: [] },
    local: { hour: 16, minute: 5 },
    current: {},
    config: {
      dayStrategyCourseDayAfterHour: 16,
      dayStrategyCourseDayAfterMinute: 0,
    },
  });

  assert.equal(strategy.id, "course_day_after_learning_window");
  assert.equal(strategy.mode, "course_day");
  assert.match(strategy.reason, /Weiterbildung\/course day/);
});

test("day strategy does not turn an early-shift operations plan into night shift", () => {
  const strategy = chooseStrategyCheckpoint({
    analysis: {
      signals: { hasNightShift: true },
      temporalContext: { scheduleMode: "night_shift", scheduleEventsToday: [] },
      levelA: [{ id: "german", label: "Deutsch", completed: false }],
      priorityTiming: { dueAtMinutes: 20 * 60 },
    },
    operationsPlan: {
      dayType: "early_shift",
      scheduleMode: "early_shift",
      currentPhase: { kind: "priority_window", reason: "after_early_shift" },
    },
    campaignStatus: { upcomingDeadlines: [] },
    tomorrow: { workEvents: [] },
    local: { hour: 16, minute: 45 },
    current: {},
    config: {
      dayStrategyEarlyShiftHour: 16,
      dayStrategyEarlyShiftMinute: 30,
    },
  });

  assert.equal(strategy.id, "early_shift_after_work_window");
  assert.equal(strategy.mode, "early_shift");
});
