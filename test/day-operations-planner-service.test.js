const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDayOperationsPlan,
  evaluatePlanPhase,
  getCanonicalDayType,
  shouldDeferForOperationsPlan,
  summarizeOperationsPlanForPrompt,
} = require("../src/services/day-operations-planner-service");

test("course day protects the course block, recovery buffer, and after-course priority window", () => {
  const analysis = analysisFixture({
    scheduleMode: "course_day",
    scheduleEventsToday: [
      { title: "Weiterbildung zur PA", calendar: "Arbeit", start: "08:30", end: "15:00" },
    ],
  });

  const duringCourse = buildDayOperationsPlan({
    analysis,
    now: new Date("2026-06-17T14:00:00+02:00"),
    config: { dayOperationsCourseRecoveryMinutes: 30 },
  });
  assert.equal(duringCourse.currentPhase.kind, "do_not_disturb");
  assert.equal(shouldDeferForOperationsPlan(duringCourse), true);
  assert.equal(duringCourse.dayType, "course_day");
  assert.equal(duringCourse.day_type, "course_day");
  assert.equal(getCanonicalDayType(duringCourse), "course_day");

  const recovering = buildDayOperationsPlan({
    analysis,
    now: new Date("2026-06-17T15:10:00+02:00"),
    config: { dayOperationsCourseRecoveryMinutes: 30 },
  });
  assert.equal(recovering.currentPhase.kind, "recovery");
  assert.equal(shouldDeferForOperationsPlan(recovering), true);

  const afterCourse = buildDayOperationsPlan({
    analysis,
    now: new Date("2026-06-17T16:05:00+02:00"),
    config: { dayOperationsCourseRecoveryMinutes: 30 },
  });
  assert.equal(afterCourse.currentPhase.kind, "priority_window");
  assert.equal(afterCourse.currentPhase.shouldSpeak, true);
  assert.match(summarizeOperationsPlanForPrompt(afterCourse), /mode=course_day/);
  assert.match(summarizeOperationsPlanForPrompt(afterCourse), /Weiterbildung zur PA 08:30-15:00/);
});

test("off day opens flexible priority windows without fixed blocks", () => {
  const plan = buildDayOperationsPlan({
    analysis: analysisFixture({ scheduleMode: "off_day", scheduleEventsToday: [], allLevelAOpen: true }),
    now: new Date("2026-06-18T11:15:00+02:00"),
    date: "2026-06-18",
    config: {},
  });

  assert.equal(plan.scheduleMode, "off_day");
  assert.equal(plan.fixedBlocks.length, 0);
  assert.equal(plan.currentPhase.kind, "priority_window");
  assert.equal(plan.currentPhase.reason, "off_day_flexible_morning");
  assert.equal(plan.assistantRhythm.version, "v2");
  assert.equal(plan.assistantRhythm.primaryLane, "health_fitness");
  assert.deepEqual(plan.assistantRhythm.oneFirstMove, {
    habitId: "sport",
    label: "Sport",
    minutes: 10,
    mode: "minimum",
    reason: "Sport is the longest Level A block and benefits from flexible off-day time.",
  });
  assert.deepEqual(plan.assistantRhythm.visibleLevelA, ["Sport", "Englisch", "Deutsch"]);
  assert.equal(plan.assistantRhythm.doNotStackLowerPriority, true);
  assert.match(summarizeOperationsPlanForPrompt(plan), /assistant_rhythm=primary health_fitness -> Sport 10m minimum/);
});

test("early shift blocks work time and adds a recovery buffer after work", () => {
  const analysis = analysisFixture({
    scheduleMode: "early_shift",
    scheduleEventsToday: [
      { title: "Frühdienst", calendar: "Arbeit", start: "05:30", end: "14:00" },
    ],
  });
  const work = buildDayOperationsPlan({
    analysis,
    now: new Date("2026-06-18T09:00:00+02:00"),
    date: "2026-06-18",
    config: { dayOperationsShiftRecoveryMinutes: 60 },
  });
  assert.equal(work.currentPhase.kind, "do_not_disturb");

  const recovery = buildDayOperationsPlan({
    analysis,
    now: new Date("2026-06-18T14:20:00+02:00"),
    date: "2026-06-18",
    config: { dayOperationsShiftRecoveryMinutes: 60 },
  });
  assert.equal(recovery.currentPhase.kind, "recovery");

  const evening = buildDayOperationsPlan({
    analysis,
    now: new Date("2026-06-18T16:10:00+02:00"),
    date: "2026-06-18",
    config: { dayOperationsShiftRecoveryMinutes: 60 },
  });
  assert.equal(evening.currentPhase.kind, "priority_window");
});

test("persisted plan phases can be re-evaluated for the current time", () => {
  const plan = buildDayOperationsPlan({
    analysis: analysisFixture({
      scheduleMode: "course_day",
      scheduleEventsToday: [
        { title: "Weiterbildung", calendar: "Arbeit", start: "08:30", end: "15:00" },
      ],
    }),
    now: new Date("2026-06-17T09:00:00+02:00"),
    config: {},
  });

  const phase = evaluatePlanPhase({ plan, now: new Date("2026-06-17T16:00:00+02:00") });
  assert.equal(phase.kind, "priority_window");
});

test("overnight shifts protect the after-midnight part of the block", () => {
  const plan = buildDayOperationsPlan({
    analysis: analysisFixture({
      scheduleMode: "night_shift",
      scheduleEventsToday: [
        {
          title: "Nachtdienst",
          calendar: "Arbeit",
          startDate: "2026-06-16",
          endDate: "2026-06-17",
          start: "21:30",
          end: "07:00",
        },
      ],
    }),
    now: new Date("2026-06-17T02:00:00+02:00"),
    date: "2026-06-17",
    config: {},
  });

  assert.equal(plan.fixedBlocks[0].start, "00:00");
  assert.equal(plan.fixedBlocks[0].end, "07:00");
  assert.equal(plan.currentPhase.kind, "do_not_disturb");
});

function analysisFixture({ scheduleMode = "normal_day", scheduleEventsToday = [], allLevelAOpen = false } = {}) {
  return {
    date: "2026-06-17",
    timeZone: "Europe/Berlin",
    scheduleMode,
    temporalContext: {
      scheduleMode,
      scheduleEventsToday,
    },
    contextQuestionTiming: {
      dueAt: "20:00",
      reason: "default_evening",
    },
    recommendedMode: "standard",
    levelA: [
      { id: "sport", label: "Sport", completed: false, estimatedMinutes: 60 },
      { id: "english", label: "Englisch", completed: !allLevelAOpen, estimatedMinutes: 25 },
      { id: "german", label: "Deutsch", completed: false, estimatedMinutes: 30 },
    ],
  };
}
