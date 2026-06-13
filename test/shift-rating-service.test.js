const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ShiftRatingService,
  classifyFatigue,
  looksLikeFutureShiftPlan,
  looksLikeShiftEnded,
  looksLikeScore,
  parseFatigueScore,
  readShiftRatingForDate,
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

test("shift rating stores numeric score and fatigue band", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-shift-rating-"));
  const stateFile = path.join(tmpDir, "state.json");
  const service = new ShiftRatingService({
    config: {
      timeZone: "Europe/Berlin",
      shiftRatingStateFile: stateFile,
    },
    channelAdapter: {
      async sendText() {},
    },
  });

  await service.observeIncoming({
    text: "夜班结束了已经",
    receivedAt: "2026-06-06T07:32:00+02:00",
    senderId: "jane",
    contextToken: "ctx",
    provider: "telegram",
  });
  await service.observeIncoming({
    text: "8分，真的很累",
    receivedAt: "2026-06-06T07:35:00+02:00",
    senderId: "jane",
    contextToken: "ctx",
    provider: "telegram",
  });

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.lastPromptBySender["telegram:jane"].score, 8);
  assert.equal(state.lastPromptBySender["telegram:jane"].fatigueBand, "high");
  const read = readShiftRatingForDate(stateFile, "2026-06-06");
  assert.equal(read.found, true);
  assert.equal(read.score, 8);
  assert.equal(read.fatigueBand, "high");
});

test("bare digit after a shift-rating prompt is captured and consumed", async () => {
  const sent = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-shift-rating-"));
  const stateFile = path.join(tmpDir, "state.json");
  const service = new ShiftRatingService({
    config: {
      timeZone: "Europe/Berlin",
      shiftRatingStateFile: stateFile,
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  });

  await service.observeIncoming({
    text: "下班啦",
    receivedAt: "2026-06-06T17:32:00+02:00",
    senderId: "jane",
    contextToken: "ctx",
    provider: "telegram",
  });
  const answer = await service.observeIncoming({
    text: "3",
    receivedAt: "2026-06-06T17:41:00+02:00",
    senderId: "jane",
    contextToken: "ctx",
    provider: "telegram",
  });

  assert.equal(answer.handled, true);
  assert.equal(answer.answered, true);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.lastPromptBySender["telegram:jane"].score, 3);
  assert.equal(state.lastPromptBySender["telegram:jane"].fatigueBand, "low");
  assert.match(sent.at(-1).text, /疲惫感 3\/10/);
});

test("bare digit without a pending shift-rating prompt is not captured", async () => {
  const sent = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-shift-rating-"));
  const stateFile = path.join(tmpDir, "state.json");
  const service = new ShiftRatingService({
    config: {
      timeZone: "Europe/Berlin",
      shiftRatingStateFile: stateFile,
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  });

  const result = await service.observeIncoming({
    text: "3",
    receivedAt: "2026-06-06T17:41:00+02:00",
    senderId: "jane",
    contextToken: "ctx",
    provider: "telegram",
  });

  assert.equal(result.handled, false);
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(sent.length, 0);
});

test("fatigue score helpers classify configured thresholds", () => {
  assert.equal(parseFatigueScore("6分吧，没睡好"), 6);
  assert.equal(parseFatigueScore("8/10"), 8);
  assert.equal(classifyFatigue(3), "low");
  assert.equal(classifyFatigue(6), "medium");
  assert.equal(classifyFatigue(7), "high");
});
