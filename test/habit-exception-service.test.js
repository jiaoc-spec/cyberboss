const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { HabitExceptionService } = require("../src/services/habit-exception-service");

test("habit exceptions remember a multi-day sport pause from natural language", () => {
  const service = new HabitExceptionService({
    config: {
      timeZone: "Europe/Berlin",
      habitExceptionStateFile: tempStateFile(),
    },
  });

  const observed = service.observeIncoming({
    text: "这几天天热不想运动，等凉快一点再说",
    receivedAt: "2026-06-25T20:00:00+02:00",
  });

  assert.equal(observed.recorded.length, 1);
  assert.equal(observed.recorded[0].habitId, "sport");
  assert.equal(observed.recorded[0].reason, "heat");

  const active = service.activeFor({
    habitId: "sport",
    now: new Date("2026-06-26T10:00:00+02:00"),
  });
  assert.ok(active);
  assert.equal(active.habitId, "sport");
  assert.match(active.sourceText, /天热不想运动/);
});

test("habit exceptions understand explicit reminder corrections", () => {
  const service = new HabitExceptionService({
    config: {
      timeZone: "Europe/Berlin",
      habitExceptionStateFile: tempStateFile(),
    },
  });

  service.observeIncoming({
    text: "昨天已经说过了这几天不运动",
    receivedAt: "2026-06-26T09:00:00+02:00",
  });

  assert.ok(service.activeFor({
    habitId: "sport",
    now: new Date("2026-06-27T09:00:00+02:00"),
  }));
});

test("habit exceptions can be cleared when the user resumes the habit", () => {
  const service = new HabitExceptionService({
    config: {
      timeZone: "Europe/Berlin",
      habitExceptionStateFile: tempStateFile(),
    },
  });
  service.observeIncoming({
    text: "这几天天热不想运动",
    receivedAt: "2026-06-25T20:00:00+02:00",
  });

  const cleared = service.observeIncoming({
    text: "今天可以恢复运动了",
    receivedAt: "2026-06-26T09:00:00+02:00",
  });

  assert.equal(cleared.cleared.length, 1);
  assert.equal(service.activeFor({
    habitId: "sport",
    now: new Date("2026-06-26T10:00:00+02:00"),
  }), null);
});

function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habit-exception-test-"));
  return path.join(dir, "state.json");
}
