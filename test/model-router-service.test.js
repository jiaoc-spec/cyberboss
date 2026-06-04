const test = require("node:test");
const assert = require("node:assert/strict");

const { ModelRouterService } = require("../src/services/model-router-service");

function createRouter() {
  return new ModelRouterService({
    config: {
      deepseekDailyRoutingEnabled: true,
      deepseekDailyMaxChars: 800,
    },
  });
}

test("model router sends ordinary daily conversation to DeepSeek", () => {
  const router = createRouter();
  assert.equal(router.decide({
    text: "下班了，今天有点累",
    senderId: "jane",
    provider: "telegram",
  }).mode, "deepseek");
  assert.equal(router.decide({
    text: "英语已经学完了",
    senderId: "jane",
    provider: "telegram",
  }).mode, "deepseek");
});

test("model router keeps tool and complex intents on Codex", () => {
  const router = createRouter();
  for (const text of [
    "明天晚上六点提醒我学习德语",
    "帮我读取苹果日历",
    "生成今天的 Obsidian 日记和 timeline 报表",
    "请分析我这个月的长期趋势",
    "帮我修复 CyberBoss 代码",
    "运动、德语、英语都必须在睡觉前完成",
  ]) {
    assert.equal(router.decide({
      text,
      senderId: "jane",
      provider: "telegram",
    }).mode, "codex", text);
  }
});

test("model router supports one-shot manual overrides", () => {
  const router = createRouter();
  router.setNextMode("jane", "codex");
  assert.equal(router.decide({
    text: "今天有点累",
    senderId: "jane",
    provider: "telegram",
  }).mode, "codex");
  assert.equal(router.decide({
    text: "今天有点累",
    senderId: "jane",
    provider: "telegram",
  }).mode, "deepseek");
});

test("model router keeps attachments and system triggers on Codex", () => {
  const router = createRouter();
  assert.equal(router.decide({
    text: "看看这个",
    senderId: "jane",
    provider: "telegram",
    attachments: [{ kind: "image" }],
  }).mode, "codex");
  assert.equal(router.decide({
    text: "random check-in",
    senderId: "jane",
    provider: "system",
  }).mode, "codex");
});
