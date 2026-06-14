const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeTelegramIncoming } = require("../src/adapters/channel/telegram");

test("telegram normalize preserves reply-to text for context resolution", () => {
  const normalized = normalizeTelegramIncoming({
    message: {
      message_id: 22,
      date: 1_765_000_000,
      chat: { id: 92555025 },
      from: { is_bot: false },
      text: "3",
      reply_to_message: {
        message_id: 21,
        from: { is_bot: true },
        text: "这次能完成，主要是什么帮到你了？\n1. 下班后马上开始\n2. 任务被拆小了\n3. 有提醒",
      },
    },
  }, {
    telegramAllowedChatIds: [],
    workspaceId: "default",
  }, "telegram-test");

  assert.equal(normalized.text, "3");
  assert.equal(normalized.replyToText.includes("这次能完成"), true);
  assert.equal(normalized.replyTo.fromBot, true);
});
