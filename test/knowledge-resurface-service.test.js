const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { KnowledgeResurfaceService } = require("../src/services/knowledge-resurface-service");

function makeFixture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-recall-vault-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-recall-state-"));
  const wiss = path.join(vault, "01. ⚪ Wissenskarte");
  fs.mkdirSync(wiss, { recursive: true });
  const queued = [];
  const config = {
    timeZone: "Europe/Berlin",
    workspaceRoot: "/workspace",
    obsidianVaultDir: vault,
    knowledgeFolder: "01. ⚪ Wissenskarte",
    knowledgeInboxFolder: "01. ⚪ Wissenskarte/00. Knowledge Inbox",
    knowledgeResurfaceHour: 17,
    knowledgeResurfaceStateFile: path.join(state, "recall.json"),
  };
  const service = new KnowledgeResurfaceService({
    config,
    channelAdapter: { getKnownContextTokens: () => ({ jane: "ctx" }) },
    sessionStore: {},
    systemMessageQueue: { enqueue: (m) => { queued.push(m); return m; } },
    currentState: { isBusyNow: () => ({ busy: false }) },
  });
  service.resolveTarget = () => ({ senderId: "jane", workspaceRoot: "/workspace" });
  return { vault, wiss, service, queued, config };
}

function writeNote(dir, name, created, tags) {
  const fm = `---\ncreated: ${created}\ntype: concept\ntags: [${tags.join(", ")}]\n---\n\n# ${name}\n核心内容。`;
  fs.writeFileSync(path.join(dir, `${name}.md`), fm, "utf8");
}

test("academic concept note resurfaces 7 days later as a question, not the answer", async () => {
  const { wiss, service, queued } = makeFixture();
  writeNote(wiss, "渗液管理与感染预防", "2026-06-06", ["Pflegewissenschaft"]);

  const result = await service.check({ accountId: "a" }, new Date("2026-06-13T18:00:00+02:00"));
  assert.equal(result.queued.length, 1);
  assert.match(queued[0].text, /Active recall \(academic\)/);
  assert.match(queued[0].text, /不要把答案直接塞给她/);
  assert.match(queued[0].text, /等她回答后/);
});

test("a non-academic life note is never quizzed", async () => {
  const { wiss, service } = makeFixture();
  writeNote(wiss, "地毯上的工作位更容易带动身体", "2026-06-06", ["生活", "环境"]);
  const result = await service.check({ accountId: "a" }, new Date("2026-06-13T18:00:00+02:00"));
  assert.equal(result.queued.length, 0);
});

test("a note with no tags is treated as a life note (not quizzed)", async () => {
  const { wiss, service } = makeFixture();
  fs.writeFileSync(path.join(wiss, "随手记.md"), "created: 2026-06-06\n没有 frontmatter tags", "utf8");
  const result = await service.check({ accountId: "a" }, new Date("2026-06-13T18:00:00+02:00"));
  assert.equal(result.queued.length, 0);
});

test("stays quiet before the recall hour", async () => {
  const { wiss, service } = makeFixture();
  writeNote(wiss, "Python 列表推导", "2026-06-06", ["Python"]);
  const result = await service.check({ accountId: "a" }, new Date("2026-06-13T15:00:00+02:00"));
  assert.equal(result.queued.length, 0);
});

test("rotation: an academic note in an extra folder with no created date still surfaces", () => {
  const { vault, service } = makeFixture();
  const pa = path.join(vault, "06. Pflegeausbildung");
  fs.mkdirSync(pa, { recursive: true });
  fs.writeFileSync(path.join(pa, "Demenz.md"), "---\ntags: [nursing, Pflegeausbildung]\n---\n\nDemenz 知识。", "utf8");
  service.config.knowledgeRecallExtraFolders = ["06. Pflegeausbildung"];
  service.config.knowledgeRecallRotationDays = 21;

  const c = service.findDueNote("2026-06-19", { resurfaced: {}, sentDates: {} }, new Date("2026-06-19T18:00:00+02:00"));
  assert.ok(c, "should find a rotation candidate");
  assert.equal(c.name, "Demenz");
  assert.equal(c.intervalDays, "rotation");

  // recently surfaced -> within cooldown -> not picked again
  const recent = { resurfaced: { "rotation:Demenz": "2026-06-18T18:00:00+02:00" }, sentDates: {} };
  assert.equal(service.findDueNote("2026-06-19", recent, new Date("2026-06-19T18:00:00+02:00")), null);
});

test("rotation: index/MOC notes (00. ...) are never quizzed", () => {
  const { vault, service } = makeFixture();
  const pa = path.join(vault, "06. Pflegeausbildung");
  fs.mkdirSync(pa, { recursive: true });
  // only an index note present -> nothing to quiz
  fs.writeFileSync(path.join(pa, "00. 护理知识地图.md"), "---\ntags: [moc, nursing]\n---\n\n# 地图", "utf8");
  service.config.knowledgeRecallExtraFolders = ["06. Pflegeausbildung"];
  const c = service.findDueNote("2026-06-19", { resurfaced: {}, sentDates: {} }, new Date("2026-06-19T18:00:00+02:00"));
  assert.equal(c, null);
});
