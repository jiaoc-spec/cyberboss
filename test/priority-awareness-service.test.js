const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PriorityAwarenessService } = require("../src/services/priority-awareness-service");
const { parseAbsoluteTime } = require("../src/services/reminder-service");

function createService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-priority-"));
  const queued = [];
  const service = new PriorityAwarenessService({
    config: {
      userName: "Jane",
      timeZone: "Europe/Berlin",
      workspaceRoot: "/workspace",
      priorityAwarenessEnabled: true,
      priorityAwarenessStateFile: path.join(dir, "priority-awareness.json"),
      priorityAwarenessCheckIntervalMs: 1,
      priorityAwarenessCooldownMs: 1,
      priorityAwarenessWakeGraceMinutes: 120,
      priorityAwarenessCheckpointMinutes: [120, 45],
      priorityAwarenessBoundaryBufferMinutes: 30,
      ...overrides.config,
    },
    timeline: overrides.timeline || null,
    channelAdapter: {
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
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
    focusProtection: overrides.focusProtection,
    currentState: overrides.currentState,
    dailyState: overrides.dailyState,
  });
  return { service, queued };
}

test("priority awareness keeps a declared list unordered and recognizes known habits", () => {
  const { service } = createService();
  const day = service.set({
    date: "2026-06-04",
    deadlineAt: "2026-06-04T16:00:00+02:00",
    deadlineLabel: "补觉",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }, { label: "Englisch" }],
  });

  assert.deepEqual(day.priorities.map((item) => item.id), ["sport", "german", "english"]);
  assert.deepEqual(day.priorities.map((item) => item.status), ["pending", "pending", "pending"]);
  assert.deepEqual(day.priorities.map((item) => item.estimatedMinutes), [60, 30, 25]);
  assert.equal(day.deadlineLabel, "补觉");
});

test("clear completion messages update matching priorities", () => {
  const { service } = createService();
  service.set({
    date: "2026-06-04",
    deadlineAt: "2026-06-04T16:00:00+02:00",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }, { label: "Englisch" }],
  });

  const result = service.observeMessage({
    text: "今天25分钟的英语学习 Rachel's English academy 已经学完了",
    receivedAt: "2026-06-04T11:59:00+02:00",
  });

  assert.deepEqual(result.updated, ["english"]);
  assert.equal(service.status({ date: "2026-06-04" }).priorities[2].status, "completed");
});

test("timeline events are completion evidence but unrelated events are ignored", () => {
  const { service } = createService();
  service.set({
    date: "2026-06-04",
    deadlineAt: "2026-06-04T16:00:00+02:00",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }],
  });

  const result = service.observeEvents({
    date: "2026-06-04",
    events: [
      { title: "运动", categoryId: "exercise", subcategoryId: "exercise.workout" },
      { title: "午饭" },
    ],
  });

  assert.deepEqual(result.updated, ["sport"]);
  assert.equal(service.status({ date: "2026-06-04" }).priorities[0].status, "completed");
});

test("monitor queues a gentle dynamic checkpoint while time remains", async () => {
  const { service, queued } = createService();
  service.set({
    date: "2026-06-04",
    deadlineAt: "2026-06-04T16:00:00+02:00",
    deadlineLabel: "补觉",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }, { label: "Englisch" }],
  });
  service.observeMessage({
    text: "英语已经学完了",
    receivedAt: "2026-06-04T13:30:00+02:00",
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-04T14:01:00+02:00"));

  assert.equal(result.queued.length, 1);
  assert.equal(queued.length, 1);
  assert.match(queued[0].text, /Completed: Englisch/);
  assert.match(queued[0].text, /Still open: Sport, Deutsch/);
  assert.match(queued[0].text, /Latest practical start time for the full versions: 14:00/);
  assert.match(queued[0].text, /unordered/);
});

test("completion reevaluation reports the latest practical start before sleep", async () => {
  const { service, queued } = createService();
  service.set({
    date: "2026-06-04",
    deadlineAt: "2026-06-04T15:00:00+02:00",
    deadlineLabel: "睡觉",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }, { label: "Englisch" }],
  });
  service.observeMessage({
    text: "英语已经学完了",
    receivedAt: "2026-06-04T12:00:00+02:00",
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-04T12:01:00+02:00"));

  assert.equal(result.queued.length, 1);
  assert.match(queued[0].text, /Estimated full-version time for open priorities: 1 hours 30 minutes/);
  assert.match(queued[0].text, /Reserved boundary preparation buffer: 30 minutes/);
  assert.match(queued[0].text, /Latest practical start time for the full versions: 13:00/);
  assert.match(queued[0].text, /still enough estimated time/);
});

test("feasibility checkpoint fires when the latest practical start window arrives", async () => {
  const { service, queued } = createService();
  service.set({
    date: "2026-06-04",
    deadlineAt: "2026-06-04T15:00:00+02:00",
    deadlineLabel: "睡觉",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }],
  });

  await service.check({ accountId: "account-1" }, new Date("2026-06-04T12:59:00+02:00"));
  assert.equal(queued.length, 0);

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-04T13:01:00+02:00"));

  assert.equal(result.queued.length, 1);
  assert.match(queued[0].text, /Latest practical start time for the full versions: 13:00/);
  assert.match(queued[0].text, /latest practical start window is at its edge/);
});

test("monitor stays silent after the deadline or when everything is closed", async () => {
  const { service, queued } = createService();
  service.set({
    date: "2026-06-04",
    deadlineAt: "2026-06-04T16:00:00+02:00",
    priorities: [{ label: "Sport" }],
  });
  service.update({ date: "2026-06-04", priorityId: "sport", status: "skipped" });

  await service.check({ accountId: "account-1" }, new Date("2026-06-04T15:00:00+02:00"));
  await service.check({ accountId: "account-1" }, new Date("2026-06-04T17:00:00+02:00"));

  assert.equal(queued.length, 0);
});

test("monitor pauses during focus protection before the hard boundary", async () => {
  const { service, queued } = createService({
    focusProtection: {
      isProtected() {
        return { protected: true, session: { task: "Englisch" } };
      },
    },
  });
  service.set({
    date: "2026-06-04",
    deadlineAt: "2026-06-04T16:00:00+02:00",
    deadlineLabel: "睡觉",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }],
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-04T13:01:00+02:00"));

  assert.equal(result.queued.length, 0);
  assert.equal(queued.length, 0);
});

test("monitor can still surface a hard-boundary warning during focus protection", async () => {
  const { service, queued } = createService({
    focusProtection: {
      isProtected() {
        return { protected: true, session: { task: "Englisch" } };
      },
    },
  });
  service.set({
    date: "2026-06-04",
    deadlineAt: "2026-06-04T16:00:00+02:00",
    deadlineLabel: "睡觉",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }],
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-04T15:35:00+02:00"));

  assert.equal(result.queued.length, 1);
  assert.equal(queued.length, 1);
  assert.match(queued[0].text, /Still open: Sport, Deutsch/);
});

test("monitor defers while the user is currently at work", async () => {
  const { service, queued } = createService({
    currentState: {
      isBusyNow() {
        return { busy: true, state: "at_work", label: "正在上班", ageMinutes: 30 };
      },
    },
  });
  service.set({
    date: "2026-06-04",
    deadlineAt: "2026-06-04T16:00:00+02:00",
    deadlineLabel: "睡觉",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }],
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-04T13:01:00+02:00"));

  assert.equal(result.queued.length, 0);
  assert.equal(result.deferred, "at_work");
  assert.equal(queued.length, 0);
});

test("monitor defers during current calendar events and includes schedule context later", async () => {
  let duringEvent = true;
  const { service, queued } = createService({
    dailyState: {
      async analyze() {
        return {
          scheduleMode: "course_day",
          temporalContext: {
            scheduleMode: "course_day",
            currentEvent: duringEvent ? { title: "Weiterbildung zur PA", start: "08:30", end: "15:00" } : null,
            scheduleEventsToday: [
              { title: "Weiterbildung zur PA", calendar: "Arbeit", start: "08:30", end: "15:00" },
            ],
          },
        };
      },
    },
  });
  service.set({
    date: "2026-06-17",
    deadlineAt: "2026-06-17T20:00:00+02:00",
    deadlineLabel: "睡觉",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }],
  });

  const blocked = await service.check({ accountId: "account-1" }, new Date("2026-06-17T14:01:00+02:00"));
  assert.equal(blocked.queued.length, 0);
  assert.equal(blocked.deferred, "calendar_event");

  duringEvent = false;
  const queuedResult = await service.check({ accountId: "account-1" }, new Date("2026-06-17T18:01:00+02:00"));
  assert.equal(queuedResult.queued.length, 1);
  assert.match(queued[0].text, /Today's schedule context: mode=course_day; Weiterbildung zur PA 08:30-15:00/);
  assert.match(queued[0].text, /do not call it an off day/);
});

test("wake-up reentry waits for the grace window before queuing priority awareness", async () => {
  const { service, queued } = createService();
  service.set({
    date: "2026-06-05",
    deadlineAt: "2026-06-05T23:00:00+02:00",
    deadlineLabel: "睡觉",
    priorities: [{ label: "Sport" }, { label: "Deutsch" }, { label: "Englisch" }],
  });
  service.observeMessage({
    text: "英语已经学完了",
    receivedAt: "2026-06-05T10:00:00+02:00",
  });

  const first = service.queueWakeReentry({ accountId: "account-1" }, {
    receivedAt: "2026-06-05T13:40:00+02:00",
  });
  const second = service.queueWakeReentry({ accountId: "account-1" }, {
    receivedAt: "2026-06-05T14:00:00+02:00",
  });

  assert.equal(first.queued.length, 0);
  assert.equal(first.scheduled, true);
  assert.equal(second.queued.length, 0);
  assert.equal(second.scheduled, true);
  assert.equal(queued.length, 0);

  const beforeGrace = await service.check({ accountId: "account-1" }, new Date("2026-06-05T15:39:00+02:00"));
  assert.equal(beforeGrace.queued.length, 0);

  const afterGrace = await service.check({ accountId: "account-1" }, new Date("2026-06-05T15:41:00+02:00"));
  assert.equal(afterGrace.queued.length, 1);
  assert.equal(queued.length, 1);
  assert.match(queued[0].text, /Wake-up reentry Priority Awareness trigger/);
  assert.match(queued[0].text, /Completed: Englisch/);
  assert.match(queued[0].text, /Still open: Sport, Deutsch/);
  assert.match(queued[0].text, /Do not ask what she is doing/);
});

test("wake-up reentry falls back to Level A when no explicit priority is set after grace", async () => {
  const { service, queued } = createService();

  const result = service.queueWakeReentry({ accountId: "account-1" }, {
    receivedAt: "2026-06-05T13:40:00+02:00",
  });

  assert.equal(result.queued.length, 0);
  const afterGrace = await service.check({ accountId: "account-1" }, new Date("2026-06-05T15:41:00+02:00"));
  assert.equal(afterGrace.queued.length, 1);
  assert.match(queued[0].text, /Use Level A as the default/);
  assert.match(queued[0].text, /Sport, Deutsch, Englisch/);
});

test("wake-up reentry stays deferred when the user is currently working", async () => {
  const { service, queued } = createService({
    currentState: {
      current() {
        return { state: "at_work", fresh: true, ageMinutes: 20 };
      },
    },
  });

  service.queueWakeReentry({ accountId: "account-1" }, {
    receivedAt: "2026-06-05T13:40:00+02:00",
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-05T15:41:00+02:00"));

  assert.equal(result.queued.length, 0);
  assert.equal(queued.length, 0);
});

test("naive reminder times use the configured Berlin timezone", () => {
  assert.equal(
    new Date(parseAbsoluteTime("2026-06-04 19:30", "Europe/Berlin")).toISOString(),
    "2026-06-04T17:30:00.000Z"
  );
});
