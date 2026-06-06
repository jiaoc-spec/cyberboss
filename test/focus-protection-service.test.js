const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  FocusProtectionService,
  FOCUS_REMINDER_PREFIX,
  parseFocusCommand,
  parseNaturalFocus,
} = require("../src/services/focus-protection-service");

function createService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-focus-"));
  const reminders = [];
  const timelineWrites = [];
  const service = new FocusProtectionService({
    config: {
      timeZone: "Europe/Berlin",
      focusProtectionEnabled: true,
      focusProtectionStateFile: path.join(dir, "focus-protection-state.json"),
    },
    reminder: {
      async create(payload, context) {
        reminders.push({ payload, context });
        return { id: "reminder-1", ...payload };
      },
    },
    timeline: {
      async write(payload) {
        timelineWrites.push(payload);
        return payload;
      },
    },
  });
  return { service, reminders, timelineWrites };
}

test("natural focus phrase starts a protected session and completion reminder", async () => {
  const { service, reminders } = createService();

  const result = await service.observeIncoming({
    provider: "telegram",
    senderId: "jane",
    text: "开始英语25分钟",
    receivedAt: "2026-06-06T10:00:00+02:00",
  });

  assert.equal(result.handled, true);
  assert.equal(result.session.task, "Englisch");
  assert.equal(result.session.endAt, "2026-06-06T08:25:00.000Z");
  assert.match(result.reply, /Englisch Focus 开始/);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].payload.dueAt, result.session.endAt);
  assert.match(reminders[0].payload.text, new RegExp(FOCUS_REMINDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("natural focus parser understands learning verbs and until times", () => {
  const now = new Date("2026-06-06T10:00:00+02:00");

  const german = parseNaturalFocus("我要学德语30分钟", now, "Europe/Berlin");
  assert.equal(german.task, "Deutsch");
  assert.equal(german.endAt.toISOString(), "2026-06-06T08:30:00.000Z");

  const until = parseNaturalFocus("不要打扰我到17:30", now, "Europe/Berlin");
  assert.equal(until.task, "Focus");
  assert.equal(until.endAt.toISOString(), "2026-06-06T15:30:00.000Z");
});

test("focus command supports duration, until, and cancel", () => {
  const now = new Date("2026-06-06T10:00:00+02:00");

  assert.equal(parseFocusCommand("25 Englisch", now, "Europe/Berlin").task, "Englisch");
  assert.equal(parseFocusCommand("until 18:00 Deutsch", now, "Europe/Berlin").endAt.toISOString(), "2026-06-06T16:00:00.000Z");
  assert.equal(parseFocusCommand("cancel", now, "Europe/Berlin").action, "cancel");
});

test("completion closes the focus and writes a timeline event", async () => {
  const { service, timelineWrites } = createService();
  await service.observeIncoming({
    provider: "telegram",
    senderId: "jane",
    text: "我要学德语30分钟",
    receivedAt: "2026-06-06T10:00:00+02:00",
  });

  const result = await service.observeIncoming({
    provider: "telegram",
    senderId: "jane",
    text: "完成",
    receivedAt: "2026-06-06T10:24:00+02:00",
  });

  assert.equal(result.handled, true);
  assert.match(result.reply, /Deutsch 收住了/);
  assert.equal(timelineWrites.length, 1);
  assert.equal(timelineWrites[0].date, "2026-06-06");
  assert.equal(timelineWrites[0].events[0].categoryId, "study");
  assert.equal(timelineWrites[0].events[0].subcategoryId, "study.language");
  assert.equal(timelineWrites[0].events[0].tags.includes("focus-protection"), true);
});

test("cancel exits active focus without deleting historical sessions", async () => {
  const { service } = createService();
  await service.observeIncoming({
    provider: "telegram",
    senderId: "jane",
    text: "我现在运动40分钟",
    receivedAt: "2026-06-06T10:00:00+02:00",
  });

  const result = await service.startFromCommand("cancel", {
    provider: "telegram",
    senderId: "jane",
    receivedAt: "2026-06-06T10:05:00+02:00",
  });

  assert.equal(result.cancelled, true);
  assert.equal(service.getActive({
    senderKey: "telegram:jane",
    now: new Date("2026-06-06T10:06:00+02:00"),
  }), null);
  assert.equal(service.loadState().sessions[0].status, "cancelled");
});
