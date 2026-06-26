const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  HabitCheckinService,
  buildHabitCheckinMessage,
  resolveHabitCheckinDueMinutes,
} = require("../src/services/habit-checkin-service");

test("habit check-in schedule follows day type defaults", () => {
  assert.equal(resolveHabitCheckinDueMinutes("early_shift", {}), 5 * 60);
  assert.equal(resolveHabitCheckinDueMinutes("late_shift", {}), 7 * 60);
  assert.equal(resolveHabitCheckinDueMinutes("off_day", {}), 7 * 60);
  assert.equal(resolveHabitCheckinDueMinutes("night_shift", {}), 17 * 60);
  assert.equal(resolveHabitCheckinDueMinutes("course_day", {}), 7 * 60);
});

test("habit check-in message includes the full visible checklist", () => {
  const text = buildHabitCheckinMessage({ date: "2026-06-26", dayType: "off_day", dueAt: "07:00" });
  assert.match(text, /□ Sport/);
  assert.match(text, /□ 英语发音/);
  assert.match(text, /□ 英语影子跟读/);
  assert.match(text, /□ 德语语法/);
  assert.match(text, /□ 德语影子跟读/);
  assert.match(text, /□ Nursing Digest/);
  assert.match(text, /不是说今天全部都要做完/);
});

test("habit check-in sends once after the configured off-day wake time", async () => {
  const sent = [];
  const service = makeService({
    sent,
    dayType: "off_day",
    stateFile: tempStateFile(),
  });

  const before = await service.check({ accountId: "telegram" }, new Date("2026-06-26T06:59:00+02:00"));
  assert.equal(before.sent, false);
  assert.equal(before.skipped, "not_due");

  service.lastCheckAtMs = 0;
  const due = await service.check({ accountId: "telegram" }, new Date("2026-06-26T07:00:00+02:00"));
  assert.equal(due.sent, true);
  assert.equal(sent.length, 1);

  service.lastCheckAtMs = 0;
  const again = await service.check({ accountId: "telegram" }, new Date("2026-06-26T08:00:00+02:00"));
  assert.equal(again.sent, false);
  assert.equal(again.skipped, "already_sent");
  assert.equal(sent.length, 1);
});

test("habit check-in uses the operations plan as source of truth for day type", async () => {
  const sent = [];
  const service = makeService({
    sent,
    dayType: "off_day",
    plannerDayType: "night_shift",
    stateFile: tempStateFile(),
  });

  const before = await service.check({ accountId: "telegram" }, new Date("2026-06-26T16:59:00+02:00"));
  assert.equal(before.sent, false);
  assert.equal(before.skipped, "not_due");
  assert.equal(before.dayType, "night_shift");

  service.lastCheckAtMs = 0;
  const due = await service.check({ accountId: "telegram" }, new Date("2026-06-26T17:00:00+02:00"));
  assert.equal(due.sent, true);
  assert.equal(due.dayType, "night_shift");
  assert.match(sent[0].text, /日程判断：夜班/);
});

function makeService({ sent, dayType, plannerDayType = "", stateFile }) {
  return new HabitCheckinService({
    config: {
      timeZone: "Europe/Berlin",
      allowedUserIds: ["jane"],
      workspaceRoot: "/tmp/cyberboss-test",
      habitCheckinStateFile: stateFile,
      habitCheckinCheckIntervalMs: 0,
    },
    dailyState: {
      async analyze() {
        return { scheduleMode: dayType };
      },
    },
    dayOperationsPlanner: plannerDayType
      ? {
        async plan() {
          return { dayType: plannerDayType, day_type: plannerDayType };
        },
      }
      : null,
    channelAdapter: {
      async sendText(message) {
        sent.push(message);
      },
      getKnownContextTokens() {
        return {};
      },
      describe() {
        return { id: "telegram" };
      },
    },
  });
}

function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habit-checkin-test-"));
  return path.join(dir, "state.json");
}
