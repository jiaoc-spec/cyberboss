const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ProactiveInterventionCoordinator } = require("../src/services/proactive-intervention-coordinator");

function makeCoordinator(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-proactive-"));
  return new ProactiveInterventionCoordinator({
    config: {
      timeZone: "Europe/Berlin",
      proactiveInterventionStateFile: path.join(dir, "state.json"),
      dayOperationsPlanStateFile: path.join(dir, "operations.json"),
      focusProtectionStateFile: path.join(dir, "focus.json"),
      currentStateFile: path.join(dir, "current.json"),
      proactiveInterventionDailyMax: 3,
      proactiveInterventionMinGapMinutes: 90,
      proactiveInterventionHardBoundaryGapMinutes: 20,
      proactiveInterventionCategoryLimits: { guardian: 2, reflection: 1, knowledge: 1, companionship: 1 },
      ...overrides,
    },
  });
}

test("one coordinator prevents parallel modules from stacking prompts", () => {
  const service = makeCoordinator();
  const now = new Date("2026-06-18T10:00:00+02:00");
  const first = service.request({ source: "day_strategy", category: "guardian", subject: "off-day", now });
  const second = service.request({ source: "critical_habit_a", category: "guardian", subject: "sport", now });
  const third = service.request({ source: "missing_context", category: "reflection", subject: "energy", now });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "minimum_gap");
  assert.equal(third.allowed, false);
  assert.equal(service.snapshot({ now }).used, 1);
});

test("daily budget and category budgets limit ordinary prompts", () => {
  const service = makeCoordinator();
  assert.equal(service.request({ source: "guardian-1", category: "guardian", subject: "a", now: "2026-06-18T08:00:00+02:00" }).allowed, true);
  assert.equal(service.request({ source: "reflection", category: "reflection", subject: "b", now: "2026-06-18T09:31:00+02:00" }).allowed, true);
  assert.equal(service.request({ source: "knowledge", category: "knowledge", subject: "c", now: "2026-06-18T11:02:00+02:00" }).allowed, true);

  const blocked = service.request({ source: "companion", category: "companionship", subject: "d", now: "2026-06-18T12:33:00+02:00" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "daily_budget");

  const boundary = service.request({ source: "priority", category: "guardian", priority: "hard_boundary", subject: "sleep", now: "2026-06-18T12:33:00+02:00" });
  assert.equal(boundary.allowed, true);
  assert.equal(service.snapshot({ now: "2026-06-18T12:33:00+02:00" }).used, 4);
});

test("fixed work or course block cannot be overridden by a hard-boundary prompt", () => {
  const service = makeCoordinator();
  fs.writeFileSync(service.config.dayOperationsPlanStateFile, JSON.stringify({
    plans: {
      "2026-06-18": {
        date: "2026-06-18",
        timeZone: "Europe/Berlin",
        dayType: "course_day",
        doNotDisturbWindows: [{ startMinutes: 9 * 60, endMinutes: 16 * 60, reason: "course_calendar_block" }],
        recoveryWindows: [],
        priorityWindows: [],
      },
    },
  }));

  const result = service.request({
    source: "priority_awareness",
    category: "guardian",
    priority: "hard_boundary",
    subject: "sport",
    now: "2026-06-18T11:00:00+02:00",
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "day_operations_do_not_disturb");
});

test("required operational work bypasses conversational budget", () => {
  const service = makeCoordinator();
  const result = service.request({
    source: "daily_review_pipeline",
    category: "reflection",
    priority: "required",
    now: "2026-06-18T00:15:00+02:00",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "required");
  assert.equal(service.snapshot({ now: "2026-06-18T00:15:00+02:00" }).used, 0);
});
