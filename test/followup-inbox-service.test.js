const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FollowupInboxService } = require("../src/services/followup-inbox-service");

function createService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-followup-"));
  const sent = [];
  const service = new FollowupInboxService({
    config: {
      userName: "Jane",
      timeZone: "Europe/Berlin",
      followupInboxEnabled: true,
      followupInboxStateFile: path.join(dir, "followup-inbox.json"),
      followupInboxCheckIntervalMs: 1,
      followupInboxHour: 10,
      followupInboxMinute: 0,
      followupInboxMaxItemsPerMessage: 3,
      ...overrides.config,
    },
    channelAdapter: overrides.channelAdapter || {
      getKnownContextTokens() {
        return { "chat-1": "chat-1" };
      },
      async sendText(payload) {
        sent.push(payload);
      },
    },
    sessionStore: overrides.sessionStore,
  });
  return { service, sent };
}

test("records an important video link and follows up from the next day", async () => {
  const { service, sent } = createService();
  const observed = service.observeIncoming({
    text: "【11分钟学完吴恩达 AI For Everyone】 https://b23.tv/JQDDOgq 提醒我今天看这个视频",
    receivedAt: "2026-06-26T12:05:00+02:00",
  });

  assert.equal(observed.recorded.length, 1);
  assert.equal(observed.recorded[0].kind, "video");
  assert.equal(observed.recorded[0].targetDate, "2026-06-26");
  assert.equal(observed.recorded[0].firstFollowupDate, "2026-06-27");

  await service.check({ accountId: "account-1" }, new Date("2026-06-26T15:30:00+02:00"));
  assert.equal(sent.length, 0);

  await service.check({ accountId: "account-1" }, new Date("2026-06-27T10:05:00+02:00"));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /我还替你记着/);
  assert.match(sent[0].text, /AI For Everyone/);
  assert.match(sent[0].text, /看完了/);
});

test("keeps reminding on later days until the item is closed", async () => {
  const { service, sent } = createService();
  service.observeIncoming({
    text: "https://b23.tv/JQDDOgq 提醒我今天看这个视频",
    receivedAt: "2026-06-26T12:05:00+02:00",
  });

  await service.check({ accountId: "account-1" }, new Date("2026-06-27T10:05:00+02:00"));
  service.lastCheckAtMs = 0;
  await service.check({ accountId: "account-1" }, new Date("2026-06-28T10:05:00+02:00"));
  assert.equal(sent.length, 2);

  const closed = service.observeIncoming({
    text: "这个视频看完了",
    receivedAt: "2026-06-28T11:00:00+02:00",
  });
  assert.equal(closed.closed.length, 1);
  assert.equal(closed.closed[0].status, "completed");

  service.lastCheckAtMs = 0;
  await service.check({ accountId: "account-1" }, new Date("2026-06-29T10:05:00+02:00"));
  assert.equal(sent.length, 2);
});

test("closes the only open follow-up when the user replies with bare completion", async () => {
  const { service, sent } = createService();
  service.observeIncoming({
    text: "https://b23.tv/JQDDOgq 提醒我今天看这个视频",
    receivedAt: "2026-06-26T12:05:00+02:00",
  });

  const closed = service.observeIncoming({
    text: "看完了",
    receivedAt: "2026-06-26T14:27:00+02:00",
  });

  assert.equal(closed.closed.length, 1);
  assert.equal(closed.closed[0].status, "completed");
  assert.match(closed.closed[0].title, /JQDDOgq|视频|重要内容/);

  await service.check({ accountId: "account-1" }, new Date("2026-06-27T10:05:00+02:00"));
  assert.equal(sent.length, 0);
});

test("does not guess which follow-up to close from bare completion when several are open", () => {
  const { service } = createService();
  service.observeIncoming({
    text: "https://b23.tv/JQDDOgq 提醒我今天看这个视频",
    receivedAt: "2026-06-26T12:05:00+02:00",
  });
  service.observeIncoming({
    text: "https://example.com/article 提醒我今天看这篇文章",
    receivedAt: "2026-06-26T12:10:00+02:00",
  });

  const closed = service.observeIncoming({
    text: "看完了",
    receivedAt: "2026-06-26T14:27:00+02:00",
  });

  assert.equal(closed.closed.length, 0);
});

test("bare completion closes the only recently reminded item even when future items are open", async () => {
  const { service, sent } = createService();
  service.observeIncoming({
    text: "https://b23.tv/JQDDOgq 提醒我今天看这个视频",
    receivedAt: "2026-06-26T12:05:00+02:00",
  });
  service.observeIncoming({
    text: "提醒我明天看 Zara Zhang 的小红书",
    receivedAt: "2026-06-27T08:01:12+02:00",
  });

  await service.check({ accountId: "account-1" }, new Date("2026-06-27T10:01:00+02:00"));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /JQDDOgq/);

  const closed = service.observeIncoming({
    text: "昨天就说了看完了",
    receivedAt: "2026-06-27T10:02:00+02:00",
  });

  assert.equal(closed.closed.length, 1);
  assert.equal(closed.closed[0].url, "https://b23.tv/JQDDOgq");

  service.lastCheckAtMs = 0;
  await service.check({ accountId: "account-1" }, new Date("2026-06-28T10:01:00+02:00"));
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Zara Zhang/);
  assert.doesNotMatch(sent[1].text, /AI For Everyone/);
});

test("records shared links as important even without explicit reminder wording", () => {
  const { service } = createService();
  const observed = service.observeIncoming({
    text: "这个链接你看一下 https://example.com",
    receivedAt: "2026-06-26T12:05:00+02:00",
  });

  assert.equal(observed.recorded.length, 1);
  assert.equal(observed.recorded[0].url, "https://example.com");
});
