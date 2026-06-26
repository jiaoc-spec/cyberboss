const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ExperienceLedgerService } = require("../src/services/experience-ledger-service");

function createService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-experience-ledger-"));
  return new ExperienceLedgerService({
    config: {
      experienceLedgerFile: path.join(dir, "experience-ledger.json"),
      experienceGuideThreshold: 3,
    },
  });
}

test("experience ledger records reusable lessons and promotes repeated themes to guide candidates", () => {
  const service = createService();

  for (const date of ["2026-06-01", "2026-06-08", "2026-06-15"]) {
    service.record({
      date,
      domain: "body_energy",
      type: "principle",
      theme: "night-shift-recovery",
      situation: "夜班后恢复不足",
      lesson: "夜班后不要按理想日安排任务，先做最小版本。",
      nextAction: "先保一个 5 分钟入口。",
      source: "daily-review",
      sourcePath: `03. 🔵 Tagebuch/01. 日记/${date}.md`,
      tags: ["night-shift", "minimum-mode"],
    });
  }

  const read = service.read({ domain: "body_energy" });
  assert.equal(read.count, 3);
  assert.equal(read.candidates.length, 1);
  assert.equal(read.candidates[0].themeKey, "night-shift-recovery");
  assert.equal(read.experiences.every((item) => item.status === "guide_candidate"), true);
});

test("creating an action guide upgrades matching experiences to guide_created", () => {
  const service = createService();
  const first = service.record({
    date: "2026-06-01",
    domain: "executive_function",
    type: "experience",
    theme: "after-work-start",
    lesson: "下班后先做最低摩擦入口，比等状态恢复更可靠。",
    nextAction: "到家后先做 5 分钟。",
  });
  service.record({
    date: "2026-06-08",
    domain: "executive_function",
    type: "experience",
    theme: "after-work-start",
    lesson: "下班后如果先坐下刷手机，启动成本会上升。",
    nextAction: "先打开材料再休息。",
  });
  service.record({
    date: "2026-06-15",
    domain: "executive_function",
    type: "experience",
    theme: "after-work-start",
    lesson: "下班后的小入口能避免整晚断线。",
    nextAction: "先做一个 5 分钟 Future Self Vote。",
  });

  const guide = service.createGuide({
    domain: "executive_function",
    theme: "after-work-start",
    title: "下班后启动行动指南",
    trigger: "下班后很累但还有 Level A 或学习任务",
    defaultAction: "先做 5 分钟入口，再决定是否加量。",
    minimumVersion: "打开材料或换运动衣。",
    notToDo: "不要先把完整计划摊开压迫自己。",
    evidenceIds: [first.experience.id],
  });

  assert.equal(guide.created, true);
  const read = service.read({ status: "guide_created" });
  assert.equal(read.count, 3);
  assert.equal(read.candidates.length, 0);
});

test("dashboard markdown summarizes stats, candidates, guides and domains", () => {
  const service = createService();
  service.record({
    date: "2026-06-20",
    domain: "learning_method",
    type: "insight",
    theme: "worst-day-baseline",
    lesson: "计划应该按最差的真实一天设计，而不是按状态最好的一天设计。",
    nextAction: "把 daily baseline 设成 5 分钟。",
  });

  const markdown = service.buildDashboardMarkdown({ date: "2026-06-20" });
  assert.match(markdown, /个人经验复利看板/);
  assert.match(markdown, /经验资产概览/);
  assert.match(markdown, /学习方法/);
  assert.match(markdown, /最差的真实一天/);
});
