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
    focusProtection: overrides.focusProtection,
    patternLedger: overrides.patternLedger,
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

test("level A reminder is paused during active focus protection", async () => {
  const { monitor, sent } = createMonitor({
    focusProtection: {
      isProtected() {
        return { protected: true, session: { task: "Englisch" } };
      },
    },
  });

  const result = await monitor.check({ accountId: "account-1" }, new Date("2026-06-05T20:04:00+02:00"));

  assert.equal(result.queued.length, 0);
  assert.equal(sent.length, 0);
});

test("high after-shift fatigue changes level A reminder to minimum mode and records pattern evidence", async () => {
  const patternCalls = [];
  const { monitor, sent } = createMonitor({
    dailyState: {
      async analyze() {
        return {
          recommendedMode: "minimum",
          shiftRating: { found: true, score: 8, fatigueBand: "high" },
          priorityTiming: { isDue: true, reason: "fixed_daily_guardian_time" },
          levelA: [
            { id: "sport", label: "Sport", completed: false },
            { id: "english", label: "Englisch", completed: true },
            { id: "german", label: "Deutsch", completed: false },
          ],
        };
      },
    },
    patternLedger: {
      recordDailyStateEvidence(args) {
        patternCalls.push(args);
        return { recorded: true };
      },
    },
  });

  const result = await monitor.check({ accountId: "account-1" }, new Date("2026-06-05T20:04:00+02:00"));

  assert.equal(result.queued.length, 1);
  assert.match(sent[0].text, /疲惫分是 8\/10/);
  assert.match(sent[0].text, /最小版本/);
  assert.equal(patternCalls.length, 1);
  assert.deepEqual(patternCalls[0].missingLevelA.map((item) => item.id), ["sport", "german"]);
});

test("collectSupportStrategies surfaces matching pattern strategies", () => {
  const { CriticalHabitsMonitor } = require("../src/services/critical-habits-monitor");
  const monitor = new CriticalHabitsMonitor({
    config: {},
    patternLedger: {
      read() {
        return {
          patterns: [
            {
              id: "pat_1",
              title: "Night shift recovery weakens Level A",
              domain: "night-shift",
              status: "hypothesis",
              confidence: 0.45,
              tags: ["night shift"],
              supportStrategy: "恢复日先看身体状态，再给 5-10 分钟版本。",
            },
            {
              id: "pat_2",
              title: "Low confidence pattern",
              domain: "night-shift",
              status: "hypothesis",
              confidence: 0.2,
              tags: [],
              supportStrategy: "不该出现。",
            },
            {
              id: "pat_3",
              title: "Unrelated domain",
              domain: "screen-time",
              status: "active",
              confidence: 0.7,
              tags: [],
              supportStrategy: "也不该出现。",
            },
          ],
        };
      },
    },
  });

  const strategies = monitor.collectSupportStrategies({
    signals: { hasNightShift: true },
  });

  assert.equal(strategies.length, 1);
  assert.equal(strategies[0].id, "pat_1");

  const none = monitor.collectSupportStrategies({ signals: {} });
  assert.equal(none.length, 0);
});

test("buildLevelADirectMessage includes support strategies", () => {
  const { buildLevelADirectMessage, DEFAULT_LEVEL_A } = require("../src/services/critical-habits-monitor");
  const text = buildLevelADirectMessage(
    [DEFAULT_LEVEL_A[0]],
    { recommendedMode: "minimum", levelA: [] },
    [{ id: "pat_1", title: "t", supportStrategy: "恢复日先给 5-10 分钟版本。" }],
  );
  assert.match(text, /恢复日先给 5-10 分钟版本/);
  assert.match(text, /我们之前观察到的规律/);
});
