const test = require("node:test");
const assert = require("node:assert/strict");

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
