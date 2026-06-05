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
  assert.match(sent[0].text, /自动流程好像没有完全收尾/);
});
