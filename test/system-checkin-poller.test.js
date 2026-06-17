const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getProtectedCheckinState, getProtectedOperationsPlanState } = require("../src/app/system-checkin-poller");

test("check-in is skipped during a recent sleep/rest pending state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-protect-"));
  const stateFile = path.join(dir, "timeline-auto-capture.json");
  fs.writeFileSync(stateFile, `${JSON.stringify({
    pending: {
      "telegram:jane": {
        startAt: "2026-06-05T08:47:00+02:00",
        text: "我现在准备睡觉了",
        classification: {
          title: "睡眠 / 休息",
          categoryId: "rest",
          subcategoryId: "rest.nap",
        },
      },
    },
  })}\n`);

  const result = getProtectedCheckinState({
    config: { timelineAutoCaptureStateFile: stateFile },
    target: { senderId: "jane" },
    now: new Date("2026-06-05T13:42:00+02:00"),
  });

  assert.equal(result.skip, true);
  assert.match(result.reason, /protected sleep\/rest window/);
});

test("check-in protection expires after the sleep/rest window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-protect-"));
  const stateFile = path.join(dir, "timeline-auto-capture.json");
  fs.writeFileSync(stateFile, `${JSON.stringify({
    pending: {
      "telegram:jane": {
        startAt: "2026-06-05T08:47:00+02:00",
        text: "我现在准备睡觉了",
        classification: {
          title: "睡眠 / 休息",
          categoryId: "rest",
          subcategoryId: "rest.nap",
        },
      },
    },
  })}\n`);

  const result = getProtectedCheckinState({
    config: { timelineAutoCaptureStateFile: stateFile },
    target: { senderId: "jane" },
    now: new Date("2026-06-05T20:00:00+02:00"),
  });

  assert.equal(result.skip, false);
});

test("check-in is skipped during active focus protection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-focus-"));
  const stateFile = path.join(dir, "focus-protection-state.json");
  fs.writeFileSync(stateFile, `${JSON.stringify({
    sessions: [{
      id: "focus-1",
      senderKey: "telegram:jane",
      status: "active",
      task: "Englisch",
      startAt: "2026-06-05T10:00:00+02:00",
      endAt: "2026-06-05T10:25:00+02:00",
    }],
  })}\n`);

  const result = getProtectedCheckinState({
    config: { focusProtectionStateFile: stateFile },
    target: { senderId: "jane" },
    now: new Date("2026-06-05T10:12:00+02:00"),
  });

  assert.equal(result.skip, true);
  assert.match(result.reason, /focus protection active/);
});

test("check-in is skipped during explicit timed early-shift work state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-work-"));
  const stateFile = path.join(dir, "current-state.json");
  fs.writeFileSync(stateFile, `${JSON.stringify({
    assertions: [{
      state: "at_work",
      label: "正在上班",
      assertedAt: "2026-06-14T07:33:00.000Z",
      sourceText: "今日 05:17 出发上的早班",
      senderKey: "telegram:jane",
    }],
    sleep: {},
  })}\n`);

  const result = getProtectedCheckinState({
    config: { currentStateFile: stateFile },
    target: { senderId: "jane" },
    now: new Date("2026-06-14T10:00:00+02:00"),
  });

  assert.equal(result.skip, true);
  assert.match(result.reason, /explicit busy state active state=at_work/);
});

test("check-in is skipped when the day operations plan says this is protected time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-operations-"));
  const stateFile = path.join(dir, "day-operations-plan.json");
  fs.writeFileSync(stateFile, `${JSON.stringify({
    plans: {
      "2026-06-17": {
        date: "2026-06-17",
        timeZone: "Europe/Berlin",
        doNotDisturbWindows: [
          {
            label: "Weiterbildung",
            reason: "course_calendar_block",
            start: "08:30",
            end: "15:00",
            startMinutes: 510,
            endMinutes: 900,
          },
        ],
        recoveryWindows: [],
        priorityWindows: [],
        levelA: { open: [{ id: "sport", label: "Sport" }], completed: [] },
      },
    },
  })}\n`);

  const result = getProtectedOperationsPlanState({
    config: {
      timeZone: "Europe/Berlin",
      dayOperationsPlanStateFile: stateFile,
    },
    now: new Date("2026-06-17T10:00:00+02:00"),
  });

  assert.equal(result.skip, true);
  assert.match(result.reason, /day operations protected phase=do_not_disturb/);
});
