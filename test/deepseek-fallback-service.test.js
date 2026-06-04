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
