const test = require("node:test");
const assert = require("node:assert/strict");

const { DeepSeekFallbackService } = require("../src/services/deepseek-fallback-service");

test("deepseek fallback sends an OpenAI-compatible request without exposing the key", async () => {
  const calls = [];
  const service = new DeepSeekFallbackService({
    config: {
      deepseekFallbackEnabled: true,
      deepseekApiKey: "secret-key",
      deepseekApiBaseUrl: "https://api.deepseek.com",
      deepseekModel: "deepseek-v4-flash",
      userName: "Jane",
    },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            model: "deepseek-v4-flash",
            choices: [{ message: { content: "收到，我们继续。" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      };
    },
  });

  const result = await service.generate({
    userText: "今天有点累",
    reason: "Codex completed without a usable reply",
    provider: "telegram",
  });

  assert.equal(result.text, "收到，我们继续。");
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-key");
  assert.equal(calls[0].options.body.includes("secret-key"), false);
});

test("deepseek fallback is disabled without an API key", async () => {
  const service = new DeepSeekFallbackService({
    config: { deepseekFallbackEnabled: true },
  });
  const result = await service.generate({ userText: "hello" });
  assert.equal(result.used, false);
  assert.equal(result.reason, "disabled");
});

test("deepseek daily mode includes recent conversation and local priority context", async () => {
  const calls = [];
  const service = new DeepSeekFallbackService({
    config: {
      deepseekFallbackEnabled: true,
      deepseekApiKey: "secret-key",
      userName: "Jane",
    },
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: "收到，英语已完成。" } }],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
          };
        },
      };
    },
  });

  await service.generate({
    mode: "daily",
    userText: "英语已经学完了",
    history: [
      { role: "user", content: "今天有点累" },
      { role: "assistant", content: "收到。" },
    ],
    context: "Open priorities: Sport, Deutsch",
  });

  const body = JSON.parse(calls[0].options.body);
  assert.match(body.messages[0].content, /ordinary daily conversation/);
  assert.match(body.messages[0].content, /gentle but steadfast Long-Term Values Guardian and Reality-Aware Guardian/);
  assert.match(body.messages[0].content, /Protect the Future Self without losing the Present Self/);
  assert.match(body.messages[0].content, /Always Return/);
  assert.match(body.messages[0].content, /nursing scientist and professor/);
  assert.match(body.messages[0].content, /Open priorities: Sport, Deutsch/);
  assert.deepEqual(body.messages.slice(1), [
    { role: "user", content: "今天有点累" },
    { role: "assistant", content: "收到。" },
    { role: "user", content: "英语已经学完了" },
  ]);
});

test("deepseek daily mode discourages logging-receipt replies", async () => {
  let body;
  const service = new DeepSeekFallbackService({
    config: {
      deepseekFallbackEnabled: true,
      deepseekApiKey: "secret-key",
      deepseekModel: "deepseek-v4-flash",
    },
    async fetchImpl(_url, options) {
      body = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            model: "deepseek-v4-flash",
            choices: [{ message: { content: "夜班安静下来以后，身体信号会变得特别明显，饿也会被放大一点。" } }],
          };
        },
      };
    },
  });

  await service.generate({
    mode: "daily",
    userText: "夜班感觉更容易饿，可能是因为很安静的关系",
  });

  assert.match(body.messages[0].content, /do not reply like a logging receipt/i);
  assert.match(body.messages[0].content, /body signal/);
});
