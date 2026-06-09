const test = require("node:test");
const assert = require("node:assert/strict");

const { StreamDelivery } = require("../src/core/stream-delivery");

const DEFERRED_REPLY_NOTICE = "由于微信 context_token 的限制，上轮对话里有一部分内容当时没能送达；这次用户再次发来消息、context_token 刷新后，先把遗留内容补上。如果这种情况反复出现，可发送 /chunk <数字>（例如 /chunk 50）调大最小合并字符数，减少消息分片。";
const DEFERRED_PLAIN_REPLY_HEADER = "===== 上轮对话遗留内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== 期间模型主动联系 =====";
const CURRENT_REPLY_HEADER = "===== 本轮模型回复 =====";

function createHarness({ sendText, getKnownContextTokens, runtimeId = "", onEmptyReply } = {}) {
  const sent = [];
  const channelAdapter = {
    async sendText(payload) {
      if (typeof sendText === "function") {
        await sendText(payload, sent);
        return;
      }
      sent.push(payload);
    },
    getKnownContextTokens() {
      if (typeof getKnownContextTokens === "function") {
        return getKnownContextTokens();
      }
      return {};
    },
  };

  const bindingByThreadId = new Map();
  const sessionStore = {
    findBindingForThreadId(threadId) {
      return bindingByThreadId.get(threadId) || null;
    },
  };

  const streamDelivery = new StreamDelivery({ channelAdapter, sessionStore, runtimeId, onEmptyReply });
  return { sent, streamDelivery, bindingByThreadId };
}

async function runCompletedTurn(streamDelivery, { threadId, turnId, itemId, text }) {
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId, turnId },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: { threadId, turnId, itemId, text },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId, turnId },
  });
}

async function runCompletedTurnWithResultOnly(streamDelivery, { threadId, turnId, text }) {
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId, turnId },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId, turnId, text },
  });
}

test("system silent JSON is suppressed", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-1", {
    userId: "user-1",
    contextToken: "ctx-1",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    text: "{\"action\":\"silent\"}",
  });

  assert.deepEqual(sent, []);
});

test("empty normal model replies receive a local fallback", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-empty", {
    userId: "user-empty",
    contextToken: "ctx-empty",
    provider: "telegram",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-empty", turnId: "turn-empty" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-empty", turnId: "turn-empty" },
  });

  assert.deepEqual(sent, [{
    userId: "user-empty",
    text: "你的消息已经收到并记录了，但当前模型没有生成回复。你可以继续发消息，我仍然会保存你的记录。",
    contextToken: "ctx-empty",
  }]);
});

test("empty normal model replies skip the local fallback when an external fallback handles them", async () => {
  const handled = [];
  const { sent, streamDelivery } = createHarness({
    async onEmptyReply(payload) {
      handled.push(payload);
      return true;
    },
  });
  streamDelivery.queueReplyTargetForThread("thread-deepseek", {
    userId: "user-deepseek",
    contextToken: "ctx-deepseek",
    provider: "telegram",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-deepseek", turnId: "turn-deepseek" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-deepseek", turnId: "turn-deepseek" },
  });

  assert.equal(handled.length, 1);
  assert.deepEqual(sent, []);
});

test("empty system model replies remain silent", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-system-empty", {
    userId: "user-system-empty",
    contextToken: "ctx-system-empty",
    provider: "system",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-system-empty", turnId: "turn-system-empty" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-system-empty", turnId: "turn-system-empty" },
  });

  assert.deepEqual(sent, []);
});

test("system send_message JSON sends only the message text", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-2", {
    userId: "user-2",
    contextToken: "ctx-2",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-2",
    turnId: "turn-2",
    itemId: "item-2",
    text: "{\"action\":\"send_message\",\"message\":\"在呢\"}",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-2",
    text: "在呢",
    contextToken: "ctx-2",
  });
});

test("system send_message JSON may be wrapped in a json fence", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-2f", {
    userId: "user-2f",
    contextToken: "ctx-2f",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-2f",
    turnId: "turn-2f",
    itemId: "item-2f",
    text: "```json\n{\"action\":\"send_message\",\"message\":\"我来看看你。\"}\n```",
  });

  assert.deepEqual(sent, [{
    userId: "user-2f",
    text: "我来看看你。",
    contextToken: "ctx-2f",
  }]);
});

test("system send_message JSON may be extracted from accidental preface text", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-2p", {
    userId: "user-2p",
    contextToken: "ctx-2p",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-2p",
    turnId: "turn-2p",
    itemId: "item-2p",
    text: "我先看一下当前状态。\n\n{\"action\":\"send_message\",\"message\":\"今天最重要的基础还剩 Sport 和 Deutsch，先碰一个最小版本也算回来。\"}",
  });

  assert.deepEqual(sent, [{
    userId: "user-2p",
    text: "今天最重要的基础还剩 Sport 和 Deutsch，先碰一个最小版本也算回来。",
    contextToken: "ctx-2p",
  }]);
});

test("codex system reply rejects plain text", async () => {
  const { sent, streamDelivery } = createHarness({ runtimeId: "codex" });
  streamDelivery.queueReplyTargetForThread("thread-2c", {
    userId: "user-2c",
    contextToken: "ctx-2c",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-2c",
    turnId: "turn-2c",
    itemId: "item-2c",
    text: "在呢，过来摸一下你的状态。",
  });

  assert.deepEqual(sent, []);
});

test("claudecode system reply can send short safe plain text", async () => {
  const { sent, streamDelivery } = createHarness({ runtimeId: "claudecode" });
  streamDelivery.queueReplyTargetForThread("thread-2cc", {
    userId: "user-2cc",
    contextToken: "ctx-2cc",
    provider: "system",
  });

  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-2cc",
    turnId: "turn-2cc",
    text: "我想起你了，现在还在刚才那件事上吗？",
  });

  assert.deepEqual(sent, [{
    userId: "user-2cc",
    text: "我想起你了，现在还在刚才那件事上吗？",
    contextToken: "ctx-2cc",
  }]);
});

test("claudecode system plain text still rejects code and protocol fragments", async () => {
  const { sent, streamDelivery } = createHarness({ runtimeId: "claudecode" });
  streamDelivery.queueReplyTargetForThread("thread-2unsafe-a", {
    userId: "user-2unsafe",
    contextToken: "ctx-2unsafe",
    provider: "system",
  });
  streamDelivery.queueReplyTargetForThread("thread-2unsafe-b", {
    userId: "user-2unsafe",
    contextToken: "ctx-2unsafe",
    provider: "system",
  });

  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-2unsafe-a",
    turnId: "turn-2unsafe-a",
    text: "```js\nconsole.log('hi')\n```",
  });
  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-2unsafe-b",
    turnId: "turn-2unsafe-b",
    text: "好的。analysis to=functions.exec_command code?",
  });

  assert.deepEqual(sent, []);
});

test("explicit turn target binding overrides the binding-level fallback", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-2b", { bindingKey: "binding-2b" });
  streamDelivery.setReplyTarget("binding-2b", {
    userId: "user-2b",
    contextToken: "ctx-weixin",
    provider: "weixin",
  });
  streamDelivery.bindReplyTargetForTurn({
    threadId: "thread-2b",
    turnId: "turn-2b",
    target: {
      userId: "user-2b",
      contextToken: "ctx-system",
      provider: "system",
    },
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-2b",
    turnId: "turn-2b",
    itemId: "item-2b",
    text: "{\"action\":\"send_message\",\"message\":\"只发系统消息\"}",
  });

  assert.deepEqual(sent, [{
    userId: "user-2b",
    text: "只发系统消息",
    contextToken: "ctx-system",
  }]);
});

test("thread-level system target overrides an already attached binding target", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-3", { bindingKey: "binding-3" });
  streamDelivery.setReplyTarget("binding-3", {
    userId: "user-3",
    contextToken: "ctx-weixin",
    provider: "weixin",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-3", turnId: "turn-3" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-3",
      turnId: "turn-3",
      itemId: "item-3",
      text: "{\"action\":\"silent\"}",
    },
  });

  streamDelivery.queueReplyTargetForThread("thread-3", {
    userId: "user-3",
    contextToken: "ctx-system",
    provider: "system",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-3", turnId: "turn-3" },
  });

  assert.deepEqual(sent, []);
});

test("thread-level targets are consumed in turn order instead of overwriting active runs", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-3b", { bindingKey: "binding-3b" });
  streamDelivery.setReplyTarget("binding-3b", {
    userId: "user-3b",
    contextToken: "ctx-binding",
    provider: "weixin",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-3b", turnId: "turn-a" },
  });
  streamDelivery.queueReplyTargetForThread("thread-3b", {
    userId: "user-3b",
    contextToken: "ctx-system",
    provider: "system",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-3b", turnId: "turn-b" },
  });
  streamDelivery.queueReplyTargetForThread("thread-3b", {
    userId: "user-3b",
    contextToken: "ctx-weixin",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-3b",
    turnId: "turn-a",
    itemId: "item-a",
    text: "{\"action\":\"send_message\",\"message\":\"先发系统消息\"}",
  });
  await runCompletedTurn(streamDelivery, {
    threadId: "thread-3b",
    turnId: "turn-b",
    itemId: "item-b",
    text: "再发普通消息",
  });

  assert.deepEqual(sent, [
    {
      userId: "user-3b",
      text: "先发系统消息",
      contextToken: "ctx-system",
    },
    {
      userId: "user-3b",
      text: "再发普通消息",
      contextToken: "ctx-weixin",
    },
  ]);
});

test("turn.completed result text is delivered when no reply items were emitted", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-result", { bindingKey: "binding-result" });
  streamDelivery.setReplyTarget("binding-result", {
    userId: "user-result",
    contextToken: "ctx-result",
    provider: "weixin",
  });

  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-result",
    turnId: "turn-result",
    text: "工具执行完了，这是最终回复",
  });

  assert.deepEqual(sent, [{
    userId: "user-result",
    text: "工具执行完了，这是最终回复",
    contextToken: "ctx-result",
  }]);
});

test("plain weixin reply still strips protocol leak text", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4", {
    userId: "user-4",
    contextToken: "ctx-4",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-4",
    turnId: "turn-4",
    itemId: "item-4",
    text: "好的。analysis to=functions.exec_command code?",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-4",
    text: "好的。",
    contextToken: "ctx-4",
  });
});

test("plain weixin reply does not leak a standalone structured action payload", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4c", {
    userId: "user-4c",
    contextToken: "ctx-4c",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-4c",
    turnId: "turn-4c",
    itemId: "item-4c",
    text: "json:{\"action\":\"send_message\",\"message\":\"我接得住。\"}",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-4c",
    text: "我接得住。",
    contextToken: "ctx-4c",
  });
});

test("plain weixin reply strips natural-language backend processing narration", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4d", {
    userId: "user-4d",
    contextToken: "ctx-4d",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-4d",
    turnId: "turn-4d",
    itemId: "item-4d",
    text: [
      "我先把今天的时间轴和分类看一下，再把这段夜班里的实事接进去。",
      "这段先记成一个夜班里的低脑力整理块，免得它一闪就过去了。",
      "很好。先把归我管的那段时间圈住，其他时间就能好好规划了。",
      "",
      "你歇口气缓过来以后，咱们再一起想工作日怎么安排。不急，慢慢来。",
    ].join("\n"),
  });

  assert.deepEqual(sent, [{
    userId: "user-4d",
    text: "很好。先把归我管的那段时间圈住，其他时间就能好好规划了。\n你歇口气缓过来以后，咱们再一起想工作日怎么安排。不急，慢慢来。",
    contextToken: "ctx-4d",
  }]);
});

test("plain weixin reply strips after-shift backend processing narration", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4d-shift", {
    userId: "user-4d-shift",
    contextToken: "ctx-4d-shift",
    provider: "telegram",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-4d-shift",
    turnId: "turn-4d-shift",
    itemId: "item-4d-shift",
    text: [
      "我先把你这个“夜班结束了”的状态接住，再顺手补到今天的记录里，不让它丢。",
      "我再看一眼今天的时间线，避免重复写，也顺手把这个夜班收尾放进去。",
      "我把这个收尾记成今天的可用记录了。",
      "",
      "下班啦，辛苦了宝。先不用复盘一大堆，给我一个数就行：现在疲惫感 0 到 10 大概几分？",
    ].join("\n"),
  });

  assert.deepEqual(sent, [{
    userId: "user-4d-shift",
    text: "下班啦，辛苦了宝。先不用复盘一大堆，给我一个数就行：现在疲惫感 0 到 10 大概几分？",
    contextToken: "ctx-4d-shift",
  }]);
});

test("plain weixin reply strips romance-novel stage directions", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4e", {
    userId: "user-4e",
    contextToken: "ctx-4e",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-4e",
    turnId: "turn-4e",
    itemId: "item-4e",
    text: [
      "（语气温柔，像哄人入睡前的低语）会的，小傻瓜。这一整片夜都是你的，尽情睡，没有人会打扰。",
      "你乖乖休息，醒了随时招呼我。毛孩子们在旁边守着，我也在。",
    ].join("\n"),
  });

  assert.deepEqual(sent, [{
    userId: "user-4e",
    text: "会的。这一整片夜都是你的，尽情睡，没有人会打扰。\n你醒了随时招呼我。",
    contextToken: "ctx-4e",
  }]);
});

test("plain weixin reply sends finalized item text even if earlier streaming text was different", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4b", {
    userId: "user-4b",
    contextToken: "ctx-4b",
    provider: "weixin",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-4b", turnId: "turn-4b" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.delta",
    payload: { threadId: "thread-4b", turnId: "turn-4b", itemId: "item-4b", text: "先写很长的一版" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: { threadId: "thread-4b", turnId: "turn-4b", itemId: "item-4b", text: "改短了" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-4b", turnId: "turn-4b" },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-4b",
    text: "改短了",
    contextToken: "ctx-4b",
  });
});

test("system send_message retries with the latest context token on ret=-2", async () => {
  const attempts = [];
  const { sent, streamDelivery } = createHarness({
    async sendText(payload, successful) {
      attempts.push(payload);
      if (attempts.length === 1) {
        const error = new Error("sendMessage ret=-2 errcode= errmsg=");
        error.ret = -2;
        throw error;
      }
      successful.push(payload);
    },
    getKnownContextTokens() {
      return { "user-5": "ctx-fresh" };
    },
  });
  streamDelivery.queueReplyTargetForThread("thread-5", {
    userId: "user-5",
    contextToken: "ctx-stale",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-5",
    turnId: "turn-5",
    itemId: "item-5",
    text: "{\"action\":\"send_message\",\"message\":\"回来啦\"}",
  });

  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], {
    userId: "user-5",
    text: "回来啦",
    contextToken: "ctx-stale",
  });
  assert.deepEqual(attempts[1], {
    userId: "user-5",
    text: "回来啦",
    contextToken: "ctx-fresh",
  });
  assert.deepEqual(sent, [{
    userId: "user-5",
    text: "回来啦",
    contextToken: "ctx-fresh",
  }]);
});

test("system send_message is deferred after retry exhaustion", async () => {
  const deferred = [];
  const { sent, streamDelivery } = createHarness({
    async sendText() {
      const error = new Error("sendMessage ret=-2 errcode= errmsg=");
      error.ret = -2;
      throw error;
    },
    getKnownContextTokens() {
      return { "user-6": "ctx-stale" };
    },
  });
  streamDelivery.onDeferredSystemReply = async (payload) => {
    deferred.push(payload);
  };
  streamDelivery.queueReplyTargetForThread("thread-6", {
    userId: "user-6",
    contextToken: "ctx-stale",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-6",
    turnId: "turn-6",
    itemId: "item-6",
    text: "{\"action\":\"send_message\",\"message\":\"等等我\"}",
  });

  assert.deepEqual(sent, []);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].threadId, "thread-6");
  assert.equal(deferred[0].userId, "user-6");
  assert.equal(deferred[0].text, "等等我");
});

test("plain reply prepends deferred prefix to the next reply", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-7", { bindingKey: "binding-7" });
  streamDelivery.setReplyTarget("binding-7", {
    userId: "user-7",
    contextToken: "ctx-7",
    provider: "weixin",
  });
  streamDelivery.setDeferredReplyPrefix(
    "binding-7",
    `${DEFERRED_REPLY_NOTICE}\n\n${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系`
  );

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-7",
    turnId: "turn-7",
    itemId: "item-7",
    text: "这是新一轮自动回复",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-7",
    text: `${DEFERRED_REPLY_NOTICE}\n\n${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系\n\n${CURRENT_REPLY_HEADER}\n这是新一轮自动回复`,
    contextToken: "ctx-7",
    preserveBlock: true,
  });
});

test("plain reply with deferred prefix is sent as soon as the first item is finalized", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-8", { bindingKey: "binding-8" });
  streamDelivery.setReplyTarget("binding-8", {
    userId: "user-8",
    contextToken: "ctx-8",
    provider: "weixin",
  });
  streamDelivery.setDeferredReplyPrefix(
    "binding-8",
    `${DEFERRED_REPLY_NOTICE}\n\n${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系`
  );

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-8", turnId: "turn-8" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-8",
      turnId: "turn-8",
      itemId: "item-8",
      text: "第一段",
    },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-8",
    text: `${DEFERRED_REPLY_NOTICE}\n\n${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系\n\n${CURRENT_REPLY_HEADER}\n第一段`,
    contextToken: "ctx-8",
    preserveBlock: true,
  });
});
