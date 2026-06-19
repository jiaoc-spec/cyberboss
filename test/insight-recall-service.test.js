const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { InsightRecallService } = require("../src/services/insight-recall-service");

function makeService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-insight-recall-"));
  const vault = path.join(root, "vault");
  const knowledge = path.join(vault, "Wissenskarte");
  const notes = path.join(vault, "Notizen");
  fs.mkdirSync(knowledge, { recursive: true });
  fs.mkdirSync(notes, { recursive: true });
  const config = {
    obsidianVaultDir: vault,
    knowledgeFolder: "Wissenskarte",
    notizenFolder: "Notizen",
    obsidianWeeklyFolder: "Weekly",
    obsidianMonthlyFolder: "Monthly",
    patternLedgerFile: path.join(root, "patterns.json"),
    decisionJournalFile: path.join(root, "decisions.json"),
    researchLedgerFile: path.join(root, "research.json"),
    campaignsFile: path.join(root, "campaigns.json"),
    insightRecallMaxResults: 3,
  };
  return { root, vault, knowledge, notes, config, service: new InsightRecallService({ config }) };
}

test("real academic work recalls related notes without becoming a new notification", () => {
  const { knowledge, service } = makeService();
  fs.writeFileSync(path.join(knowledge, "Trauma-informed Care.md"), [
    "---",
    "type: concept",
    "tags: [pflegewissenschaft, trauma-informed-care]",
    "source: SAMHSA paper",
    "source_type: peer_reviewed_article",
    "---",
    "# Trauma-informed Care",
    "Safety, trust and choice are central principles.",
  ].join("\n"));

  const result = service.buildContext({ text: "我在写 Trauma-informed Care 的 Hausarbeit，准备整理 argument map" });
  assert.equal(result.triggered, true);
  assert.equal(result.items[0].evidenceType, "academic_note");
  assert.match(result.text, /Keep evidence types separate/);
  assert.match(result.text, /Trauma-informed Care/);
});

test("ordinary daily chat does not search the Second Brain", () => {
  const { service } = makeService();
  const result = service.buildContext({ text: "夜班有点饿，今天真的挺安静的" });
  assert.equal(result.triggered, false);
  assert.deepEqual(result.items, []);
});

test("personal patterns and academic evidence stay separately labeled", () => {
  const { config, knowledge, service } = makeService();
  fs.writeFileSync(path.join(knowledge, "Shift work cognition.md"), [
    "---",
    "type: concept",
    "tags: [night-shift, cognition]",
    "source: Journal article",
    "source_type: peer_reviewed_article",
    "---",
    "Night shift can affect cognitive performance.",
  ].join("\n"));
  fs.writeFileSync(config.patternLedgerFile, JSON.stringify({
    patterns: [{ id: "p1", title: "夜班后学习启动困难", status: "hypothesis", summary: "夜班后德语更少", hypothesis: "可能与疲惫有关" }],
  }));

  const result = service.buildContext({ text: "我想研究夜班和学习连续性的关系" });
  assert.equal(result.triggered, true);
  assert.ok(result.items.some((item) => item.evidenceType === "academic_note"));
  assert.ok(result.items.some((item) => item.evidenceType === "personal_pattern"));
});
