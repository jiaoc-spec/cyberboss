const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { HabitObservationService } = require("../src/services/habit-observation-service");

function createService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-habit-observation-"));
  return new HabitObservationService({
    config: {
      timeZone: "Europe/Berlin",
      habitObservationStateFile: path.join(dir, "habit-observations.json"),
    },
  });
}

test("records combined English and German completion from natural language", () => {
  const service = createService();
  const result = service.observeIncoming({
    text: "我已经练了英语和德语",
    receivedAt: "2026-06-25T18:30:00+02:00",
  });

  assert.deepEqual(result.recorded.map((entry) => entry.habitId).sort(), ["english", "german"]);
  assert.ok(service.completedFor({ habitId: "english", date: "2026-06-25" }));
  assert.ok(service.completedFor({ habitId: "german", date: "2026-06-25" }));
});

test("records correction wording as completion", () => {
  const service = createService();
  const result = service.observeIncoming({
    text: "英语和德语不是已经练完了吗？",
    receivedAt: "2026-06-25T20:30:00+02:00",
  });

  assert.deepEqual(result.recorded.map((entry) => entry.habitId).sort(), ["english", "german"]);
});

test("does not record future intention or negated wording", () => {
  const service = createService();

  assert.deepEqual(service.observeIncoming({
    text: "我待会要去练英语",
    receivedAt: "2026-06-25T18:30:00+02:00",
  }).recorded, []);
  assert.deepEqual(service.observeIncoming({
    text: "今天还没学德语",
    receivedAt: "2026-06-25T18:30:00+02:00",
  }).recorded, []);
});
