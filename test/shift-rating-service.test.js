const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ShiftRatingService,
  looksLikeFutureShiftPlan,
  looksLikeShiftEnded,
  looksLikeScore,
} = require("../src/services/shift-rating-service");

test("shift rating asks immediately after concrete off-work report", async () => {
  const sent = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-shift-rating-"));
  const service = new ShiftRatingService({
    config: {
      timeZone: "Europe/Berlin",
      shiftRatingStateFile: path.join(tmpDir, "state.json"),
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  });

  const result = await service.observeIncoming({
    text: "6:50下班，6:58坐车回家",
    receivedAt: "2026-06-06T04:59:00.000Z",
    senderId: "jane",
    contextToken: "ctx",
    provider: "telegram",
  });

  assert.equal(result.handled, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /下班啦，辛苦了宝/);
  assert.match(sent[0].text, /疲惫感 0 到 10/);
});

test("shift rating does not ask twice before a score answer", async () => {
  const sent = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-shift-rating-"));
  const service = new ShiftRatingService({
    config: {
      timeZone: "Europe/Berlin",
      shiftRatingStateFile: path.join(tmpDir, "state.json"),
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  });

  await service.observeIncoming({
    text: "夜班结束了已经",
    receivedAt: "2026-06-06T05:32:00.000Z",
    senderId: "jane",
    contextToken: "ctx",
    provider: "telegram",
  });
  const duplicate = await service.observeIncoming({
    text: "下班了",
    receivedAt: "2026-06-06T05:35:00.000Z",
    senderId: "jane",
    contextToken: "ctx",
    provider: "telegram",
  });

  assert.equal(duplicate.handled, false);
  assert.equal(sent.length, 1);
});

test("shift rating helper classifiers avoid future plans", () => {
  assert.equal(looksLikeShiftEnded("6:50下班，6:58坐车回家"), true);
  assert.equal(looksLikeShiftEnded("夜班结束了"), true);
  assert.equal(looksLikeFutureShiftPlan("明天6:50下班"), true);
  assert.equal(looksLikeFutureShiftPlan("6:50下班，6:58坐车回家"), false);
  assert.equal(looksLikeScore("6分吧，没睡好"), true);
});
