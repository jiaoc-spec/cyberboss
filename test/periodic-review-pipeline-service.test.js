const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PeriodicReviewPipelineService } = require("../src/services/periodic-review-pipeline-service");

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-periodic-"));
  const queued = [];
  const config = {
    timeZone: "Europe/Berlin",
    workspaceRoot: "/workspace",
    periodicReviewPipelineStateFile: path.join(dir, "periodic.json"),
    weeklyReviewPipelineHour: 20,
    monthlyReviewPipelineHour: 9,
    periodicReviewPipelineMaxAttempts: 3,
    periodicReviewPipelineRetryDelayMs: 60_000,
    obsidianVaultDir: path.join(dir, "vault"),
    obsidianWeeklyFolder: "周记",
    obsidianMonthlyFolder: "月记",
    obsidianDailyFolder: "日记",
  };
  const service = new PeriodicReviewPipelineService({
    config,
    channelAdapter: { getKnownContextTokens: () => ({ "chat-1": "token-1" }) },
    sessionStore: {
      buildBindingKey: () => "binding",
      getActiveWorkspaceRoot: () => "/workspace",
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
      hasPendingForAccount: () => false,
    },
  });
  return { dir, queued, config, service };
}

test("weekly review queues on Sunday evening", async () => {
  const { queued, service } = makeFixture();
  // 2026-06-14 is a Sunday
  const result = await service.check({ accountId: "a" }, new Date("2026-06-14T20:30:00+02:00"));
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].kind, "weekly");
  assert.equal(result.actions[0].action, "queued");
  assert.match(queued[0].text, /WEEKLY REVIEW PIPELINE week=2026-W24/);
  assert.match(queued[0].text, /每周复盘/);
  assert.match(queued[0].text, /Identity Ledger \/ Be-Do-Have/);
  assert.match(queued[0].text, /健康体能、语言能力、护理科学\/教学科研、舞蹈表达/);
});

test("weekly review stays quiet before Sunday evening and on other days", async () => {
  const { queued, service } = makeFixture();
  assert.equal((await service.check({ accountId: "a" }, new Date("2026-06-14T19:00:00+02:00"))).actions.length, 0);
  service.lastCheckAtMs = 0;
  assert.equal((await service.check({ accountId: "a" }, new Date("2026-06-13T21:00:00+02:00"))).actions.length, 0);
  assert.equal(queued.length, 0);
});

test("weekly review completes when the marker exists", async () => {
  const { dir, queued, service } = makeFixture();
  const weekDir = path.join(dir, "vault", "周记");
  fs.mkdirSync(weekDir, { recursive: true });
  fs.writeFileSync(path.join(weekDir, "2026-W24.md"), "已有模板\n\n## 每周复盘\n内容\n", "utf8");

  const result = await service.check({ accountId: "a" }, new Date("2026-06-14T20:30:00+02:00"));
  assert.equal(result.actions[0].action, "complete");
  assert.equal(queued.length, 0);
  assert.equal(service.statusFor("weekly:2026-W24").status, "complete");
});

test("monthly review targets the previous month on the 1st", async () => {
  const { queued, service } = makeFixture();
  const result = await service.check({ accountId: "a" }, new Date("2026-07-01T09:30:00+02:00"));
  const monthly = result.actions.find((action) => action.kind === "monthly");
  assert.equal(monthly.action, "queued");
  assert.equal(monthly.runKey, "monthly:2026-06");
  const monthlyText = queued.find((m) => m.id.startsWith("monthly")).text;
  assert.match(monthlyText, /month=2026-06/);
  assert.match(monthlyText, /身份体检 \/ Be-Do-Have/);
  assert.match(monthlyText, /护理科学家\/教授\/教师\/ANP\/研究者/);
});

test("monthly review does not run mid-month", async () => {
  const { service } = makeFixture();
  const result = await service.check({ accountId: "a" }, new Date("2026-06-15T10:00:00+02:00"));
  assert.equal(result.actions.filter((a) => a.kind === "monthly").length, 0);
});
