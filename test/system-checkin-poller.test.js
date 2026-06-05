const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getProtectedCheckinState } = require("../src/app/system-checkin-poller");

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
