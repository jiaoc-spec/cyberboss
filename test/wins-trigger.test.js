const test = require("node:test");
const assert = require("node:assert/strict");
const { detectWinTrigger, parseWinsResponse } = require("../src/core/wins-trigger");
const { WinsLedgerState } = require("../src/core/wins-ledger-state");

// --- detectWinTrigger ---

test("detects 完成了英语", () => {
  const result = detectWinTrigger("完成了5分钟英语");
  assert.ok(result);
  assert.equal(result.task, "Englisch");
  assert.equal(result.domain, "learning");
});

test("detects 做了运动", () => {
  const result = detectWinTrigger("做了30分钟运动");
  assert.ok(result);
  assert.equal(result.task, "Sport");
});

test("detects 学了德语", () => {
  const result = detectWinTrigger("学了10分钟德语");
  assert.ok(result);
  assert.equal(result.task, "Deutsch");
});

test("detects 跑了", () => {
  const result = detectWinTrigger("今天跑了5公里");
  assert.ok(result);
  assert.equal(result.task, "Sport");
});

test("detects 完成了Sport (English label)", () => {
  const result = detectWinTrigger("完成了Sport");
  assert.ok(result);
  assert.equal(result.task, "Sport");
});

test("detects 搞定了英语", () => {
  const result = detectWinTrigger("搞定了今天的英语");
  assert.ok(result);
  assert.equal(result.task, "Englisch");
});

test("does not trigger without habit name", () => {
  assert.equal(detectWinTrigger("完成了任务"), null);
});

test("does not trigger with negation 还没", () => {
  assert.equal(detectWinTrigger("还没做运动"), null);
});

test("does not trigger with 没有", () => {
  assert.equal(detectWinTrigger("今天没有学英语"), null);
});

test("does not trigger with future intention 打算", () => {
  assert.equal(detectWinTrigger("打算做运动"), null);
});

test("does not trigger on empty string", () => {
  assert.equal(detectWinTrigger(""), null);
});

// --- parseWinsResponse ---

test("parses single digit", () => {
  const r = parseWinsResponse("3");
  assert.equal(r.success_factor, "had_reminder");
  assert.equal(r.note, "");
});

test("parses 2和3", () => {
  const r = parseWinsResponse("2和3");
  assert.equal(r.success_factor, "small_chunk");
  assert.ok(r.note.includes("had_reminder"));
});

test("parses 2 还有3", () => {
  const r = parseWinsResponse("2 还有3");
  assert.equal(r.success_factor, "small_chunk");
  assert.ok(r.note.includes("had_reminder"));
});

test("parses 2+3", () => {
  const r = parseWinsResponse("2+3");
  assert.equal(r.success_factor, "small_chunk");
  assert.ok(r.note.includes("had_reminder"));
});

test("parses 6 with free text", () => {
  const r = parseWinsResponse("6. 今天状态特别好，睡够了");
  assert.equal(r.success_factor, "other");
  assert.ok(r.note.includes("今天状态特别好"));
});

test("returns null for no digit", () => {
  assert.equal(parseWinsResponse("好的"), null);
  assert.equal(parseWinsResponse(""), null);
  assert.equal(parseWinsResponse("abc"), null);
});

test("returns null for digit out of range", () => {
  assert.equal(parseWinsResponse("7"), null);
  assert.equal(parseWinsResponse("0"), null);
});

// --- WinsLedgerState ---

test("setPending and getPending work", () => {
  const state = new WinsLedgerState();
  state.setPending("user1", { task: "Englisch", domain: "learning", date: "2026-06-06" });
  const pending = state.getPending("user1");
  assert.equal(pending.task, "Englisch");
  assert.equal(pending.domain, "learning");
});

test("clearPending removes state", () => {
  const state = new WinsLedgerState();
  state.setPending("user1", { task: "Sport", domain: "health", date: "2026-06-06" });
  state.clearPending("user1");
  assert.equal(state.hasPending("user1"), false);
});

test("state is isolated per sender", () => {
  const state = new WinsLedgerState();
  state.setPending("u1", { task: "Sport", domain: "health", date: "2026-06-06" });
  state.setPending("u2", { task: "Deutsch", domain: "learning", date: "2026-06-06" });
  state.clearPending("u1");
  assert.equal(state.hasPending("u1"), false);
  assert.equal(state.hasPending("u2"), true);
});
