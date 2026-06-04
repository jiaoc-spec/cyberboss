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
      priorityAwarenessCheckpointMinutes: [120, 45],
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
  assert.match(queued[0].text, /unordered/);
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

test("naive reminder times use the configured Berlin timezone", () => {
  assert.equal(
    new Date(parseAbsoluteTime("2026-06-04 19:30", "Europe/Berlin")).toISOString(),
    "2026-06-04T17:30:00.000Z"
  );
});
