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
    currentState: overrides.currentState,
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
  assert.match(sent[0].text, /Sport：5-10 分钟散步、拉伸或任意低门槛身体活动/);
  assert.match(sent[0].text, /Englisch：5 分钟英语发音/);
  assert.match(sent[0].text, /Deutsch：5-10 分钟德语语法或影子跟读/);
  assert.match(sent[0].text, /最差日基线/);
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

test("level A midday rhythm check fires before the evening guardian without consuming guardian keys", async () => {
  const patternCalls = [];
  const { monitor, sent } = createMonitor({
    config: {
      criticalHabitsLevelAMiddayHour: 12,
      criticalHabitsLevelAMiddayMinute: 30,
    },
    dailyState: {
      async analyze() {
        return {
          recommendedMode: "standard",
          priorityTiming: {
            isDue: false,
            missingLevelA: ["sport", "english", "german"],
            reason: "fixed_daily_guardian_time",
          },
          temporalContext: { currentEvent: null },
          levelA: [
            { id: "sport", label: "Sport", completed: false },
            { id: "english", label: "Englisch", completed: false },
            { id: "german", label: "Deutsch", completed: false },
          ],
        };
      },
    },
    patternLedger: {
      recordDailyStateEvidence(args) {
        patternCalls.push(args);
      },
    },
  });

  const midday = await monitor.check({ accountId: "account-1" }, new Date("2026-06-05T12:31:00+02:00"));
  const evening = await monitor.check({ accountId: "account-1" }, new Date("2026-06-05T20:04:00+02:00"));

  assert.equal(midday.queued.length, 1);
  assert.match(midday.queued[0].text, /未来自己的地基/);
  assert.equal(evening.queued.length, 1);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /不催你/);
  assert.match(sent[0].text, /不是要你立刻把全部做完/);
  assert.match(sent[1].text, /今天最重要的地基/);
  assert.equal(patternCalls.length, 1, "midday soft check must not count as failure evidence");
});

test("queued level A fallback includes identity-ledger instructions", () => {
  const { monitor, queued } = createMonitor();

  monitor.enqueueLevelAMessage({
    account: { accountId: "account-1" },
    target: { senderId: "chat-1", workspaceRoot: "/workspace" },
    missing: [{ item: DEFAULT_LEVEL_A[0], key: "A:2026-06-05:sport" }],
    now: new Date("2026-06-05T20:04:00+02:00"),
  });

  assert.equal(queued.length, 1);
  assert.match(queued[0].text, /Be-Do-Have frame/);
  assert.match(queued[0].text, /Identity mapping/);
  assert.match(queued[0].text, /Consistency protocol/);
  assert.match(queued[0].text, /Sport: 5-10 分钟散步、拉伸或任意低门槛身体活动/);
});

test("level B check queues at most one habit per eligible day", async () => {
  const { monitor, queued } = createMonitor({
    config: {
      criticalHabitsLevelAMiddayHour: 23,
      criticalHabitsLevelBWeekdays: [2, 4, 7],
    },
  });

  const result = await monitor.check({ accountId: "account-1" }, new Date("2026-06-09T18:03:00+02:00"));

  assert.equal(result.queued.length, 1);
  assert.equal(queued.length, 1);
  assert.match(queued[0].text, /Praxisanleitung/);
  assert.doesNotMatch(queued[0].text, /Python/);
  assert.doesNotMatch(queued[0].text, /Wundmanagement/);
});

test("level B check staggers remaining habits across eligible days", async () => {
  const { monitor, queued } = createMonitor({
    config: {
      criticalHabitsLevelAMiddayHour: 23,
      criticalHabitsLevelBWeekdays: [2, 4, 7],
    },
  });

  const tuesday = await monitor.check({ accountId: "account-1" }, new Date("2026-06-09T18:03:00+02:00"));
  const thursday = await monitor.check({ accountId: "account-1" }, new Date("2026-06-11T18:03:00+02:00"));
  const sunday = await monitor.check({ accountId: "account-1" }, new Date("2026-06-14T18:03:00+02:00"));

  assert.equal(tuesday.queued.length, 1);
  assert.equal(thursday.queued.length, 1);
  assert.equal(sunday.queued.length, 1);
  assert.equal(queued.length, 3);
  assert.match(queued[0].text, /Praxisanleitung/);
  assert.match(queued[1].text, /Wundmanagement/);
  assert.match(queued[2].text, /Python/);
});

test("level B check does not backfill another habit on the same date", async () => {
  const { monitor, queued } = createMonitor({
    config: {
      criticalHabitsLevelAMiddayHour: 23,
      criticalHabitsLevelBWeekdays: [2, 4, 7],
    },
  });

  const first = await monitor.check({ accountId: "account-1" }, new Date("2026-06-09T18:03:00+02:00"));
  const second = await monitor.check({ accountId: "account-1" }, new Date("2026-06-09T18:30:00+02:00"));

  assert.equal(first.queued.length, 1);
  assert.equal(second.queued.length, 0);
  assert.equal(queued.length, 1);
});

test("level A midday rhythm check respects the wake-up grace window", async () => {
  const { monitor, sent } = createMonitor({
    config: {
      criticalHabitsLevelAMiddayHour: 12,
      criticalHabitsLevelAMiddayMinute: 30,
      criticalHabitsWakeGraceMinutes: 120,
    },
    currentState: {
      isBusyNow() {
        return { busy: false };
      },
      current() {
        return { state: "woke_up", fresh: true, ageMinutes: 30 };
      },
    },
  });

  const result = await monitor.check({ accountId: "account-1" }, new Date("2026-06-05T12:31:00+02:00"));

  assert.equal(result.queued.length, 0);
  assert.equal(result.deferred, "woke_up");
  assert.equal(sent.length, 0);
});

test("level A midday rhythm check respects current calendar events", async () => {
  const { monitor, sent } = createMonitor({
    config: {
      criticalHabitsLevelAMiddayHour: 12,
      criticalHabitsLevelAMiddayMinute: 30,
    },
    dailyState: {
      async analyze() {
        return {
          temporalContext: { currentEvent: { title: "网课", start: "12:00", end: "13:30" } },
          priorityTiming: { isDue: false, missingLevelA: ["sport"] },
          levelA: [{ id: "sport", label: "Sport", completed: false }],
        };
      },
    },
  });

  const result = await monitor.check({ accountId: "account-1" }, new Date("2026-06-05T12:31:00+02:00"));

  assert.equal(result.queued.length, 0);
  assert.equal(result.deferred, "calendar_event");
  assert.equal(sent.length, 0);
});

test("level A midday rhythm check is skipped when day strategy already prompted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-day-strategy-sent-"));
  const dayStrategyStateFile = path.join(dir, "day-strategy-state.json");
  fs.writeFileSync(dayStrategyStateFile, `${JSON.stringify({
    sent: {
      "2026-06-05:off_day_open_window": "2026-06-05T11:05:00+02:00",
    },
  })}\n`);
  const { monitor, sent } = createMonitor({
    config: {
      criticalHabitsLevelAMiddayHour: 12,
      criticalHabitsLevelAMiddayMinute: 30,
      dayStrategyStateFile,
    },
    dailyState: {
      async analyze() {
        return {
          temporalContext: { currentEvent: null },
          priorityTiming: { isDue: false, missingLevelA: ["sport", "english", "german"] },
          levelA: [
            { id: "sport", label: "Sport", completed: false },
            { id: "english", label: "Englisch", completed: false },
            { id: "german", label: "Deutsch", completed: false },
          ],
        };
      },
    },
  });

  const result = await monitor.check({ accountId: "account-1" }, new Date("2026-06-05T12:31:00+02:00"));

  assert.equal(result.queued.length, 0);
  assert.equal(sent.length, 0);
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
