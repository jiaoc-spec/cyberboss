const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DayStrategyService } = require("../src/services/day-strategy-service");

function createService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-day-strategy-"));
  const queued = [];
  const service = new DayStrategyService({
    config: {
      userName: "Jane",
      timeZone: "Europe/Berlin",
      workspaceRoot: "/workspace",
      dayStrategyEnabled: true,
      dayStrategyStateFile: path.join(dir, "day-strategy-state.json"),
      dayStrategyCheckIntervalMs: 1,
      dayStrategyWakeGraceMinutes: 120,
      ...overrides.config,
    },
    dailyState: overrides.dailyState || {
      async analyze() {
        return analysisFixture({ hasOffDay: true });
      },
    },
    calendar: overrides.calendar || {
      async read() {
        return { events: [] };
      },
    },
    campaign: overrides.campaign || {
      async status() {
        return { activeCampaigns: [], upcomingDeadlines: [] };
      },
    },
    channelAdapter: {
      describe() {
        return { id: "telegram" };
      },
      getKnownContextTokens() {
        return { "chat-1": "token-1" };
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
      hasPendingForAccount() {
        return Boolean(overrides.pending);
      },
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
    focusProtection: overrides.focusProtection,
    currentState: overrides.currentState,
  });
  return { service, queued };
}

test("off day queues a strategy prompt after the open window", async () => {
  const { service, queued } = createService({
    calendar: {
      async read() {
        return {
          events: [
            {
              title: "Frühdienst",
              calendar: "Arbeit",
              start: "2026-06-13T04:30:00+02:00",
              end: "2026-06-13T12:30:00+02:00",
            },
          ],
        };
      },
    },
    campaign: {
      async status() {
        return {
          upcomingDeadlines: [
            { label: "Statistik Klausur", daysLeft: 10, habitId: "python" },
          ],
        };
      },
    },
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-12T12:31:00+02:00"));

  assert.equal(result.queued.length, 1);
  assert.equal(result.strategy.id, "off_day_open_window");
  assert.equal(queued.length, 1);
  assert.match(queued[0].text, /Day Strategy Assistant/);
  assert.match(queued[0].text, /Schedule mode: off_day/);
  assert.match(queued[0].text, /Tomorrow morning work context: Frühdienst 04:30-12:30/);
  assert.match(queued[0].text, /Statistik Klausur in 10d -> python/);
});

test("off day strategy does not repeat after it has been sent", async () => {
  const { service, queued } = createService();

  await service.check({ accountId: "account-1" }, new Date("2026-06-12T12:31:00+02:00"));
  const second = await service.check({ accountId: "account-1" }, new Date("2026-06-12T13:31:00+02:00"));

  assert.equal(queued.length, 1);
  assert.equal(second.queued.length, 0);
});

test("strategy respects wake-up grace", async () => {
  const { service, queued } = createService({
    currentState: {
      isBusyNow() {
        return { busy: false };
      },
      current() {
        return { state: "woke_up", fresh: true, ageMinutes: 20 };
      },
    },
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-12T12:31:00+02:00"));

  assert.equal(result.queued.length, 0);
  assert.equal(result.deferred, "woke_up");
  assert.equal(queued.length, 0);
});

test("strategy respects current calendar events", async () => {
  const { service, queued } = createService({
    dailyState: {
      async analyze() {
        return {
          ...analysisFixture({ hasOffDay: true }),
          temporalContext: {
            localNow: "2026-06-12 12:31",
            currentEvent: { title: "网课", start: "12:00", end: "13:30" },
          },
        };
      },
    },
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-12T12:31:00+02:00"));

  assert.equal(result.queued.length, 0);
  assert.equal(result.deferred, "calendar_event");
  assert.equal(queued.length, 0);
});

test("late shift day queues a morning-window strategy", async () => {
  const { service, queued } = createService({
    dailyState: {
      async analyze() {
        return analysisFixture({ hasLateShift: true });
      },
    },
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-12T10:31:00+02:00"));

  assert.equal(result.queued.length, 1);
  assert.equal(result.strategy.id, "late_shift_morning_window");
  assert.match(queued[0].text, /Schedule mode: late_shift/);
});

test("strategy stays quiet when all Level A habits are already complete and no deadline is near", async () => {
  const { service, queued } = createService({
    dailyState: {
      async analyze() {
        return analysisFixture({ hasOffDay: true, allDone: true });
      },
    },
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-12T12:31:00+02:00"));

  assert.equal(result.queued.length, 0);
  assert.equal(queued.length, 0);
});

function analysisFixture({ hasOffDay = false, hasEarlyShift = false, hasLateShift = false, hasNightShift = false, allDone = false } = {}) {
  return {
    generatedAt: "2026-06-12T10:31:00.000Z",
    signals: { hasOffDay, hasEarlyShift, hasLateShift, hasNightShift },
    temporalContext: {
      localNow: "2026-06-12 12:31",
      currentEvent: null,
    },
    priorityTiming: {
      dueAtMinutes: 20 * 60,
    },
    levelA: [
      { id: "sport", label: "Sport", estimatedMinutes: 60, completed: allDone },
      { id: "english", label: "Englisch", estimatedMinutes: 25, completed: allDone },
      { id: "german", label: "Deutsch", estimatedMinutes: 30, completed: allDone },
    ],
  };
}
