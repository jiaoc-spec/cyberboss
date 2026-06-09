const test = require("node:test");
const assert = require("node:assert/strict");
const { detectDecisionTrigger, buildDecisionTriggerAnnotation } = require("../src/core/decision-trigger");

test("detects 我决定", () => {
  assert.ok(detectDecisionTrigger("我决定先继续用 DeepSeek fallback，不马上升级 Pro。"));
});

test("detects 不马上", () => {
  assert.ok(detectDecisionTrigger("不马上升级 Pro，够用就行。"));
});

test("detects 我打算", () => {
  assert.ok(detectDecisionTrigger("我打算今年10月开始读护理本科。"));
});

test("detects 要不要", () => {
  assert.ok(detectDecisionTrigger("我还在想要不要换工作。"));
});

test("detects 我在纠结", () => {
  assert.ok(detectDecisionTrigger("我在纠结要不要续费会员。"));
});

test("detects 我选择", () => {
  assert.ok(detectDecisionTrigger("我选择先不报这个课程。"));
});

test("detects 暂时不", () => {
  assert.ok(detectDecisionTrigger("暂时不换科室了，先把现在的工作做好。"));
});

test("detects 我先 when not a physical action", () => {
  assert.ok(detectDecisionTrigger("我先继续用旧方案，不升级。"));
});

test("does not trigger on empty string", () => {
  assert.equal(detectDecisionTrigger(""), false);
});

test("does not trigger on null/undefined", () => {
  assert.equal(detectDecisionTrigger(null), false);
  assert.equal(detectDecisionTrigger(undefined), false);
});

test("does not trigger on trivial food choice", () => {
  assert.equal(detectDecisionTrigger("我决定吃什么好呢"), false);
});

test("does not trigger on trivial clothing choice", () => {
  assert.equal(detectDecisionTrigger("我决定穿什么"), false);
});

test("does not trigger on trivial route choice", () => {
  assert.equal(detectDecisionTrigger("走哪条路好"), false);
});

test("我先去 is not a decision trigger", () => {
  assert.equal(detectDecisionTrigger("我先去洗澡"), false);
});

test("我先去吃饭 is not a decision trigger", () => {
  assert.equal(detectDecisionTrigger("我先去吃饭"), false);
});

test("buildDecisionTriggerAnnotation returns non-empty string", () => {
  const annotation = buildDecisionTriggerAnnotation();
  assert.ok(typeof annotation === "string");
  assert.ok(annotation.length > 0);
  assert.ok(annotation.includes("Decision Journal"));
});

test("annotation tells model not to ask again (bridge already sent the prompt)", () => {
  const annotation = buildDecisionTriggerAnnotation();
  assert.ok(annotation.includes("Do NOT ask about Decision Journal again"));
});
