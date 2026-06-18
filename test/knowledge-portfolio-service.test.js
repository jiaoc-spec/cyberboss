const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { KnowledgePortfolioService } = require("../src/services/knowledge-portfolio-service");

function makeService() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-portfolio-"));
  const folder = path.join(vault, "Wissenskarte");
  fs.mkdirSync(folder, { recursive: true });
  return {
    vault,
    folder,
    service: new KnowledgePortfolioService({
      config: {
        obsidianVaultDir: vault,
        knowledgeFolder: "Wissenskarte",
        knowledgeInboxFolder: "Wissenskarte/00. Knowledge Inbox",
      },
    }),
  };
}

test("audits source metadata, graph links, and themes", () => {
  const { folder, service } = makeService();
  fs.writeFileSync(path.join(folder, "00. 知识地图.md"), "# MOC\n\n- [[Trauma-informed Care]]\n", "utf8");
  fs.writeFileSync(path.join(folder, "Trauma-informed Care.md"), [
    "---",
    "created: 2026-06-18",
    "type: concept",
    "source: SAMHSA guideline",
    "source_type: guideline",
    "tags: [pflegewissenschaft, trauma-informed-care]",
    "---",
    "# Trauma-informed Care",
    "This concept focuses on safety, trust, collaboration, empowerment, and choice. It matters in psychiatric nursing because the care environment can otherwise reproduce loss of control.",
    "",
    "Related: [[Safety in psychiatric nursing]]",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(folder, "Safety in psychiatric nursing.md"), [
    "---",
    "created: 2026-06-18",
    "type: concept",
    "source: unknown",
    "source_type: unknown",
    "tags: [pflegewissenschaft]",
    "---",
    "# Safety",
    "Safety is not only physical protection. It also includes predictability, communication, relational trust, and preserving agency in restrictive clinical environments.",
  ].join("\n"), "utf8");

  const result = service.audit();
  assert.equal(result.conceptCount, 2);
  assert.ok(result.topThemes.some((item) => item.tag === "pflegewissenschaft" && item.count === 2));
  assert.ok(result.issues.some((issue) => issue.code === "unknown_source_type" && issue.title === "Safety in psychiatric nursing"));
  assert.ok(!result.issues.some((issue) => issue.code === "broken_link"));
  assert.match(service.buildDashboardMarkdown(result), /Long-Term Memory Dashboard/);
});

test("reports broken links and orphan concept cards without modifying notes", () => {
  const { folder, service } = makeService();
  const filePath = path.join(folder, "孤立概念.md");
  const original = [
    "---",
    "type: concept",
    "tags: [research]",
    "---",
    "This is a concept card with enough body text to be meaningful, but its source metadata and graph connections are incomplete. [[不存在的卡片]]",
  ].join("\n");
  fs.writeFileSync(filePath, original, "utf8");

  const result = service.audit();
  assert.ok(result.issues.some((issue) => issue.code === "missing_source"));
  assert.ok(result.issues.some((issue) => issue.code === "orphan_note"));
  assert.ok(result.issues.some((issue) => issue.code === "broken_link"));
  assert.equal(fs.readFileSync(filePath, "utf8"), original);
});
