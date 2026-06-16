const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DailyReviewPipelineService } = require("../src/services/daily-review-pipeline-service");

function makeFixture({ maxAttempts = 3, retryDelayMs = 1000, queueBusy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-review-pipeline-"));
  const queued = [];
  const archived = [];
  const config = {
    timeZone: "Europe/Berlin",
    workspaceRoot: "/workspace",
    dailyReviewPipelineEnabled: true,
    dailyReviewPipelineStateFile: path.join(dir, "pipeline.json"),
    dailyReviewPipelineHour: 0,
    dailyReviewPipelineMinute: 15,
    dailyReviewPipelineMaxAttempts: maxAttempts,
    dailyReviewPipelineRetryDelayMs: retryDelayMs,
    dailyReviewPipelineCheckIntervalMs: 1,
    obsidianVaultDir: path.join(dir, "vault"),
    obsidianDailyFolder: "daily",
  };
  const service = new DailyReviewPipelineService({
    config,
    channelAdapter: {
      getKnownContextTokens() {
        return { "chat-1": "token-1" };
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
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
      hasPendingForAccount() {
        return queueBusy;
      },
    },
    dailyInbox: {
      archive({ date }) {
        archived.push(date);
        return { date, archived: true };
      },
    },
  });
  return { dir, queued, archived, config, service };
}

function writeCompleteReview(dir, date) {
  const noteDir = path.join(dir, "vault", "daily");
  fs.mkdirSync(noteDir, { recursive: true });
  fs.writeFileSync(path.join(noteDir, `${date}.md`), "## 每日复盘\n内容已生成\n", "utf8");
}

test("pipeline waits until the scheduled window opens", async () => {
  const { queued, service } = makeFixture();
  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-06T00:05:00+02:00"));
  assert.equal(result.action, "before_window");
  assert.equal(queued.length, 0);
});

test("pipeline queues a review request with the output contract", async () => {
  const { queued, service } = makeFixture();
  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-06T00:20:00+02:00"));
  assert.equal(result.action, "queued");
  assert.equal(result.targetDate, "2026-06-05");
  assert.equal(queued.length, 1);
  assert.match(queued[0].text, /DAILY REVIEW PIPELINE date=2026-06-05/);
  assert.match(queued[0].text, /## 每日复盘/);
  assert.match(queued[0].text, /nextObservation/);
  assert.match(queued[0].text, /Be-Do-Have \/ Identity Ledger/);
  assert.match(queued[0].text, /健康、有体能、身体自主的人/);
  assert.match(queued[0].text, /Future Self Vote/);
  assert.match(queued[0].text, /consistency_review/);
  assert.match(queued[0].text, /今天什么起作用了？哪里断了？明天最小调整是什么？/);
  assert.match(queued[0].text, /短期反馈只用于校准路径和动作/);
  assert.match(queued[0].text, /长期资产包括：认知资产/);
  assert.match(queued[0].text, /过程导向不是自我安慰/);
  assert.match(queued[0].text, /long_termism/);
});

test("pipeline retries with delay and gives up after max attempts", async () => {
  const { queued, service } = makeFixture({ maxAttempts: 2, retryDelayMs: 60_000 });
  const base = Date.parse("2026-06-06T00:20:00+02:00");

  service.lastCheckAtMs = 0;
  assert.equal((await service.check({ accountId: "a" }, new Date(base))).action, "queued");
  service.lastCheckAtMs = 0;
  assert.equal((await service.check({ accountId: "a" }, new Date(base + 30_000))).action, "waiting_retry");
  service.lastCheckAtMs = 0;
  assert.equal((await service.check({ accountId: "a" }, new Date(base + 61_000))).action, "queued");
  service.lastCheckAtMs = 0;
  assert.equal((await service.check({ accountId: "a" }, new Date(base + 130_000))).action, "gave_up");
  service.lastCheckAtMs = 0;
  assert.equal((await service.check({ accountId: "a" }, new Date(base + 200_000))).action, "settled");
  assert.equal(queued.length, 2);
  assert.match(queued[1].text, /第 2 次尝试/);
});

test("pipeline marks complete and archives the inbox when the review exists", async () => {
  const { dir, queued, archived, service, config } = makeFixture();
  writeCompleteReview(dir, "2026-06-05");

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-06T00:20:00+02:00"));

  assert.equal(result.action, "complete");
  assert.equal(queued.length, 0);
  assert.deepEqual(archived, ["2026-06-05"]);
  const state = JSON.parse(fs.readFileSync(config.dailyReviewPipelineStateFile, "utf8"));
  assert.equal(state.runs["daily-review:2026-06-05"].status, "complete");
  assert.equal(service.statusFor("2026-06-05").status, "complete");
});

test("pipeline does not queue while the system queue is busy", async () => {
  const { queued, service } = makeFixture({ queueBusy: true });
  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-06T00:20:00+02:00"));
  assert.equal(result.action, "queue_busy");
  assert.equal(queued.length, 0);
});
