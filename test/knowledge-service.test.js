const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { KnowledgeService } = require("../src/services/knowledge-service");

function makeService() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-knowledge-"));
  fs.mkdirSync(path.join(vault, "Wissenskarte"), { recursive: true });
  fs.writeFileSync(path.join(vault, "Wissenskarte", "Wundmanagement Grundlagen.md"), "# Wundmanagement\nExsudat...", "utf8");
  fs.writeFileSync(path.join(vault, "Wissenskarte", "Statistik Basics.md"), "# Statistik\np-Wert...", "utf8");
  const service = new KnowledgeService({
    config: {
      timeZone: "Europe/Berlin",
      obsidianVaultDir: vault,
      knowledgeFolder: "Wissenskarte",
      knowledgeInboxFolder: "Wissenskarte/00. Knowledge Inbox",
    },
  });
  return { vault, service };
}

test("capture writes a note with frontmatter and related links", async () => {
  const { vault, service } = makeService();
  const result = await service.capture({
    title: "Exsudatmanagement und Infektionsprophylaxe",
    content: "今天课上的关键点：渗液管理直接影响感染预防的效果。",
    tags: ["Wundmanagement"],
    source: "Blickpunkt Wunde Fortbildung",
    date: "2026-06-11",
  });
  assert.ok(result.filePath.startsWith(path.join(vault, "Wissenskarte/00. Knowledge Inbox")));
  const text = fs.readFileSync(result.filePath, "utf8");
  assert.match(text, /source: Blickpunkt Wunde Fortbildung/);
  assert.match(text, /# Exsudatmanagement und Infektionsprophylaxe/);
  assert.match(text, /\[\[Wundmanagement Grundlagen\]\]/);
  assert.deepEqual(result.relatedNotes, ["Wundmanagement Grundlagen"]);
});

test("capture avoids overwriting an existing note with the same name", async () => {
  const { service } = makeService();
  const first = await service.capture({ title: "同名笔记", content: "v1", date: "2026-06-11" });
  const second = await service.capture({ title: "同名笔记", content: "v2", date: "2026-06-11" });
  assert.notEqual(first.filePath, second.filePath);
  assert.ok(fs.existsSync(first.filePath));
  assert.ok(fs.existsSync(second.filePath));
});

test("search matches by title and by content", async () => {
  const { service } = makeService();
  const byTitle = await service.search({ query: "statistik" });
  assert.equal(byTitle.results.length, 1);
  assert.equal(byTitle.results[0].match, "title");

  const byContent = await service.search({ query: "p-Wert" });
  assert.equal(byContent.results.length, 1);
  assert.equal(byContent.results[0].match, "content");
  assert.match(byContent.results[0].snippet, /p-Wert/);
});
