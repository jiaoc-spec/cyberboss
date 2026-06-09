const test = require("node:test");
const assert = require("node:assert/strict");
const { DecisionJournalState, isDecisionJournalConfirmation } = require("../src/core/decision-journal-state");

test("setPending and getPending work", () => {
  const state = new DecisionJournalState();
  state.setPending("user1", { text: "我决定X", date: "2026-06-06" });
  const pending = state.getPending("user1");
  assert.equal(pending.text, "我决定X");
  assert.equal(pending.date, "2026-06-06");
});

test("hasPending returns true after setPending", () => {
  const state = new DecisionJournalState();
  assert.equal(state.hasPending("user1"), false);
  state.setPending("user1", { text: "X", date: "2026-06-06" });
  assert.equal(state.hasPending("user1"), true);
});

test("clearPending removes state", () => {
  const state = new DecisionJournalState();
  state.setPending("user1", { text: "X", date: "2026-06-06" });
  state.clearPending("user1");
  assert.equal(state.hasPending("user1"), false);
  assert.equal(state.getPending("user1"), null);
});

test("state is isolated per senderId", () => {
  const state = new DecisionJournalState();
  state.setPending("user1", { text: "A", date: "2026-06-06" });
  state.setPending("user2", { text: "B", date: "2026-06-06" });
  state.clearPending("user1");
  assert.equal(state.hasPending("user1"), false);
  assert.equal(state.hasPending("user2"), true);
});

test("isDecisionJournalConfirmation: 记录", () => {
  assert.ok(isDecisionJournalConfirmation("记录"));
});

test("isDecisionJournalConfirmation: 好", () => {
  assert.ok(isDecisionJournalConfirmation("好"));
});

test("isDecisionJournalConfirmation: yes", () => {
  assert.ok(isDecisionJournalConfirmation("yes"));
});

test("isDecisionJournalConfirmation: 对", () => {
  assert.ok(isDecisionJournalConfirmation("对"));
});

test("isDecisionJournalConfirmation: 好的", () => {
  assert.ok(isDecisionJournalConfirmation("好的"));
});

test("isDecisionJournalConfirmation: not for regular messages", () => {
  assert.equal(isDecisionJournalConfirmation("我决定先不记录"), false);
  assert.equal(isDecisionJournalConfirmation("不用了"), false);
  assert.equal(isDecisionJournalConfirmation("随便"), false);
  assert.equal(isDecisionJournalConfirmation(""), false);
});

test("isDecisionJournalConfirmation: trims whitespace", () => {
  assert.ok(isDecisionJournalConfirmation("  记录  "));
});
