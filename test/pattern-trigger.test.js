const test = require("node:test");
const assert = require("node:assert/strict");

// Copy pattern-trigger.js to ~/cyberboss for testing
const { detectPatternViewTrigger, formatPatternList } = require("../src/core/pattern-trigger");

test("detects 看一下模式", () => {
  assert.ok(detectPatternViewTrigger("看一下最近的模式"));
});

test("detects 模式列表", () => {
  assert.ok(detectPatternViewTrigger("模式列表"));
});

test("detects 有哪些模式", () => {
  assert.ok(detectPatternViewTrigger("有哪些模式"));
});

test("detects 查模式", () => {
  assert.ok(detectPatternViewTrigger("查一下模式"));
});

test("does not trigger on normal message", () => {
  assert.equal(detectPatternViewTrigger("完成了英语"), false);
  assert.equal(detectPatternViewTrigger("我决定换工作"), false);
  assert.equal(detectPatternViewTrigger(""), false);
});

test("formatPatternList: empty returns message", () => {
  const result = formatPatternList([]);
  assert.ok(result.includes("还没有记录"));
});

test("formatPatternList: formats pattern correctly", () => {
  const patterns = [{
    title: "Night shift weakens habits",
    domain: "health",
    status: "hypothesis",
    confidence: "medium",
    evidence: [{ note: "x" }, { note: "y" }],
    intervention_ideas: [{ idea: "z" }],
  }];
  const result = formatPatternList(patterns);
  assert.ok(result.includes("Night shift weakens habits"));
  assert.ok(result.includes("health"));
  assert.ok(result.includes("medium"));
  assert.ok(result.includes("证据: 2条"));
  assert.ok(result.includes("干预建议: 1条"));
});

test("formatPatternList: handles missing fields gracefully", () => {
  const patterns = [{ title: "Minimal pattern", domain: "energy" }];
  const result = formatPatternList(patterns);
  assert.ok(result.includes("Minimal pattern"));
  assert.ok(result.includes("证据: 0条"));
});
