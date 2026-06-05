const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CriticalHabitsMonitor,
  DEFAULT_LEVEL_A,
  DEFAULT_LEVEL_B,
} = require("../src/services/critical-habits-monitor");

function createMonitor(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-critical-"));
  const queued = [];
  const sent = [];
  const monitor = new CriticalHabitsMonitor({
    config: {
      userName: "Jane",
      timeZone: "Europe/Berlin",
      workspaceRoot: "/workspace",
      criticalHabitsEnabled: true,
      criticalHabitsStateFile: path.join(dir, "critical-habits-state.json"),
      criticalHabitsCheckIntervalMs: 1,
      criticalHabitsLevelAHour: 20,
      criticalHabitsLevelBHour: 18,
      criticalHabitsLevelBWeekdays: [],
      criticalHabitsLevelA: DEFAULT_LEVEL_A,
      criticalHabitsLevelB: DEFAULT_LEVEL_B,
      ...overrides.config,
    },
    timeline: overrides.timeline || {
      async read() {
        return { data: { events: [] } };
      },
    },
    channelAdapter: {
      getKnownContextTokens() {
        return { "chat-1": "token-1" };
      },
      async sendText(payload) {
        sent.push(payload);
      },
    },
    sessionStore: {
      buildBindingKey() {
        return "binding";
      },
      getActiveWorkspaceRoot() {
        return "/workspace";
      },
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
    dailyState: overrides.dailyState,
  });
  return { monitor, queued, sent };
}

test("level A missing habits are combined into one direct guardian reminder", async () => {
  const { monitor, queued, sent } = createMonitor();

  const result = await monitor.check({ accountId: "account-1" }, new Date("2026-06-05T20:04:00+02:00"));

  assert.equal(result.queued.length, 1);
  assert.equal(queued.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Sport、Englisch、Deutsch/);
  assert.match(sent[0].text, /重点不是完美，是回来/);
});

test("level A reminder can trigger before fixed hour on night shift days", async () => {
  const { monitor, sent } = createMonitor({
    config: {
      criticalHabitsLevelAHour: 20,
      criticalHabitsNightShiftLeadMinutes: 180,
    },
    dailyState: {
      async analyze() {
        return {
          recommendedMode: "minimum",
          priorityTiming: {
            isDue: true,
            reason: "night_shift_boundary",
            boundaryLabel: "夜班前",
          },
          levelA: [
            { id: "sport", label: "Sport", completed: false },
            { id: "english", label: "Englisch", completed: true },
            { id: "german", label: "Deutsch", completed: false },
          ],
        };
      },
    },
  });

  const result = await monitor.check({ accountId: "account-1" }, new Date("2026-06-05T18:35:00+02:00"));

  assert.equal(result.queued.length, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /已经完成：Englisch/);
  assert.match(sent[0].text, /夜班前/);
  assert.match(sent[0].text, /Sport、Deutsch/);
  assert.doesNotMatch(sent[0].text, /Englisch 的记录/);
});
