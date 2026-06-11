const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FailureWatchdogService } = require("../src/services/failure-watchdog-service");

test("failure watchdog notifies when previous daily review is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-"));
  const sent = [];
  const service = new FailureWatchdogService({
    config: {
      timeZone: "Europe/Berlin",
      workspaceRoot: "/workspace",
      failureWatchdogEnabled: true,
      failureWatchdogStateFile: path.join(dir, "watchdog.json"),
      failureWatchdogHour: 2,
      failureWatchdogCheckIntervalMs: 1,
      dailyInboxArchiveDir: path.join(dir, "archive"),
      obsidianVaultDir: path.join(dir, "vault"),
      obsidianDailyFolder: "daily",
    },
    channelAdapter: {
      getKnownContextTokens() {
        return { "chat-1": "token-1" };
      },
      async sendText(payload) {
        sent.push(payload);
      },
    },
    sessionStore: {
      buildBindingKey() {
        return "binding";
      },
      getActiveWorkspaceRoot() {
        return "/workspace";
      },
    },
    dailyInbox: {
      read() {
        return { exists: true, filePath: path.join(dir, "inbox.md"), text: "raw" };
      },
    },
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-06T02:10:00+02:00"));

  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /2026-06-05/);
  assert.match(sent[0].text, /自动流程没有成功收尾/);
});

function makeWatchdogFixture({ reviewPipeline = undefined, inboxExists = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-"));
  const sent = [];
  const archived = [];
  const config = {
    timeZone: "Europe/Berlin",
    workspaceRoot: "/workspace",
    failureWatchdogEnabled: true,
    failureWatchdogStateFile: path.join(dir, "watchdog.json"),
    failureWatchdogHour: 2,
    failureWatchdogCheckIntervalMs: 1,
    failureWatchdogRecheckDays: 7,
    dailyInboxArchiveDir: path.join(dir, "archive"),
    obsidianVaultDir: path.join(dir, "vault"),
    obsidianDailyFolder: "daily",
  };
  const service = new FailureWatchdogService({
    config,
    channelAdapter: {
      getKnownContextTokens() {
        return { "chat-1": "token-1" };
      },
      async sendText(payload) {
        sent.push(payload);
      },
    },
    sessionStore: {
      buildBindingKey() {
        return "binding";
      },
      getActiveWorkspaceRoot() {
        return "/workspace";
      },
    },
    dailyInbox: {
      read({ date }) {
        return { exists: inboxExists, filePath: path.join(dir, `${date}.md`), text: "raw" };
      },
      archive({ date }) {
        archived.push(date);
        return { date, archived: true };
      },
    },
    reviewPipeline,
  });
  return { dir, sent, archived, config, service };
}

function writeCompleteReview(dir, date) {
  const noteDir = path.join(dir, "vault", "daily");
  fs.mkdirSync(noteDir, { recursive: true });
  fs.writeFileSync(path.join(noteDir, `${date}.md`), "## 每日复盘\n内容已生成\n", "utf8");
}

test("failure watchdog stays quiet while review pipeline is still retrying", async () => {
  const { sent, service } = makeWatchdogFixture({
    reviewPipeline: {
      statusFor() {
        return { status: "pending", attempts: 1 };
      },
    },
  });

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-06T02:10:00+02:00"));

  assert.equal(result.sent, false);
  assert.equal(sent.length, 0);
});

test("failure watchdog notifies once after pipeline gives up, then stays quiet", async () => {
  const { sent, service } = makeWatchdogFixture({
    reviewPipeline: {
      statusFor() {
        return { status: "gave_up", attempts: 3 };
      },
    },
  });

  const first = await service.check({ accountId: "account-1" }, new Date("2026-06-06T02:10:00+02:00"));
  service.lastCheckAtMs = 0;
  const second = await service.check({ accountId: "account-1" }, new Date("2026-06-06T03:10:00+02:00"));

  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /已尝试 3 次/);
});

test("failure watchdog flips a failed entry back to ok when the review appears later", async () => {
  const { dir, service, config } = makeWatchdogFixture({
    inboxExists: false,
    reviewPipeline: {
      statusFor() {
        return { status: "pending", attempts: 1 };
      },
    },
  });

  await service.check({ accountId: "account-1" }, new Date("2026-06-06T02:10:00+02:00"));
  let state = JSON.parse(fs.readFileSync(config.failureWatchdogStateFile, "utf8"));
  assert.equal(state.checked["daily-review:2026-06-05"].ok, false);

  writeCompleteReview(dir, "2026-06-05");
  service.lastCheckAtMs = 0;
  await service.check({ accountId: "account-1" }, new Date("2026-06-06T04:10:00+02:00"));
  state = JSON.parse(fs.readFileSync(config.failureWatchdogStateFile, "utf8"));
  assert.equal(state.checked["daily-review:2026-06-05"].ok, true);
  assert.ok(state.checked["daily-review:2026-06-05"].recoveredAt);
});

test("failure watchdog auto-archives the inbox when review is complete", async () => {
  const { dir, service, archived } = makeWatchdogFixture({
    inboxExists: true,
    reviewPipeline: {
      statusFor() {
        return { status: "complete", attempts: 1 };
      },
    },
  });
  writeCompleteReview(dir, "2026-06-05");

  await service.check({ accountId: "account-1" }, new Date("2026-06-06T02:10:00+02:00"));

  assert.ok(archived.includes("2026-06-05"));
});
