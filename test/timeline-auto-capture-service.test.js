const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const { TimelineAutoCaptureService } = require("../src/services/timeline-auto-capture-service");

test("timeline auto capture does not open commute pending for planned departure times", async () => {
  const writes = [];
  const service = new TimelineAutoCaptureService({
    config: {
      diaryTimeZone: "Europe/Berlin",
      timelineAutoCaptureStateFile: "",
    },
    timeline: {
      async write(payload) {
        writes.push(payload);
      },
    },
  });

  const result = await service.captureMessage({
    text: "我夜班的话，我自己定了两个闹钟20.02是换衣服，然后20:17出发，因为我的火车是20:30",
    receivedAt: "2026-06-04T10:11:36+02:00",
    senderId: "jane",
    provider: "telegram",
  });

  assert.deepEqual(result.events, []);
  assert.equal(result.pending, null);
  assert.deepEqual(writes, []);
});

test("timeline auto capture opens sleep pending for immediate sleep messages", async () => {
  const writes = [];
  const stateFile = "/tmp/cyberboss-timeline-auto-sleep-test.json";
  try {
    fs.unlinkSync(stateFile);
  } catch {}
  const service = new TimelineAutoCaptureService({
    config: {
      diaryTimeZone: "Europe/Berlin",
      timelineAutoCaptureStateFile: stateFile,
    },
    timeline: {
      async write(payload) {
        writes.push(payload);
      },
    },
  });

  const result = await service.captureMessage({
    text: "我现在准备睡觉了",
    receivedAt: "2026-06-05T08:47:00+02:00",
    senderId: "jane",
    provider: "telegram",
  });

  assert.equal(result.events.length, 0);
  assert.equal(result.pending.classification.subcategoryId, "rest.nap");
  assert.deepEqual(writes, []);
});

test("timeline auto capture closes sleep pending on wake-up messages", async () => {
  const writes = [];
  const stateFile = "/tmp/cyberboss-timeline-auto-wake-test.json";
  try {
    fs.unlinkSync(stateFile);
  } catch {}
  const service = new TimelineAutoCaptureService({
    config: {
      diaryTimeZone: "Europe/Berlin",
      timelineAutoCaptureStateFile: stateFile,
    },
    timeline: {
      async write(payload) {
        writes.push(payload);
      },
    },
  });

  await service.captureMessage({
    text: "我现在准备睡觉了",
    receivedAt: "2026-06-05T08:47:00+02:00",
    senderId: "jane",
    provider: "telegram",
  });
  const result = await service.captureMessage({
    text: "我已经醒了",
    receivedAt: "2026-06-05T13:40:00+02:00",
    senderId: "jane",
    provider: "telegram",
  });

  assert.equal(result.wokeUp, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].subcategoryId, "rest.nap");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].events[0].title, "睡眠 / 休息");
});
