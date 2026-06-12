const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ObsidianNoteService } = require("../src/services/obsidian-note-service");

function makeService() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-obsnote-"));
  fs.mkdirSync(path.join(vault, "日记"), { recursive: true });
  const service = new ObsidianNoteService({
    config: {
      obsidianVaultDir: vault,
      obsidianDailyFolder: "日记",
      obsidianWeeklyFolder: "周记",
      obsidianMonthlyFolder: "月记",
      knowledgeFolder: "Wissenskarte",
    },
  });
  return { vault, service };
}

test("replace_placeholder fills the pending marker in place", async () => {
  const { vault, service } = makeService();
  fs.writeFileSync(path.join(vault, "日记", "2026-06-11.md"), "# 标题\n\n待午夜后自动生成\n\n## 其他\n保留我\n", "utf8");

  const result = await service.write({
    relativePath: "日记/2026-06-11.md",
    content: "## 每日复盘\n今天的内容",
    mode: "replace_placeholder",
  });

  assert.equal(result.action, "replaced_placeholder");
  const text = fs.readFileSync(path.join(vault, "日记", "2026-06-11.md"), "utf8");
  assert.match(text, /## 每日复盘\n今天的内容/);
  assert.doesNotMatch(text, /待午夜后自动生成/);
  assert.match(text, /保留我/);
});

test("append never deletes existing content and creates missing files", async () => {
  const { vault, service } = makeService();
  fs.writeFileSync(path.join(vault, "日记", "2026-06-12.md"), "已有内容\n", "utf8");

  await service.write({ relativePath: "日记/2026-06-12.md", content: "## 每日复盘\n追加" });
  const text = fs.readFileSync(path.join(vault, "日记", "2026-06-12.md"), "utf8");
  assert.match(text, /^已有内容\n\n## 每日复盘\n追加\n$/);

  const created = await service.write({ relativePath: "周记/2026-W24.md", content: "## 每周复盘\n新建" });
  assert.equal(created.action, "created");
  assert.ok(fs.existsSync(path.join(vault, "周记", "2026-W24.md")));
});

test("rejects paths outside allowed folders and non-md files", async () => {
  const { service } = makeService();
  await assert.rejects(() => service.write({ relativePath: "../escape.md", content: "x" }), /outside allowed folders/);
  await assert.rejects(() => service.write({ relativePath: "随便/note.md", content: "x" }), /outside allowed folders/);
  await assert.rejects(() => service.write({ relativePath: "日记/../../etc/passwd.md", content: "x" }), /outside allowed folders/);
  await assert.rejects(() => service.write({ relativePath: "日记/script.sh", content: "x" }), /only \.md files/);
});

test("read returns content or exists=false", async () => {
  const { vault, service } = makeService();
  fs.writeFileSync(path.join(vault, "日记", "2026-06-13.md"), "内容\n", "utf8");
  const found = await service.read({ relativePath: "日记/2026-06-13.md" });
  assert.equal(found.exists, true);
  assert.match(found.text, /内容/);
  const missing = await service.read({ relativePath: "日记/2099-01-01.md" });
  assert.equal(missing.exists, false);
});
