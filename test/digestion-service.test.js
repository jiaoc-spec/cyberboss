const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DigestionService, parseDigestionReply, buildPromotionTrigger } = require("../src/services/digestion-service");

function makeFixture() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-digest-vault-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-digest-state-"));
  const inbox = path.join(vault, "01. ⚪ Wissenskarte/00. Knowledge Inbox");
  const notizen = path.join(vault, "02. 🟡 Notizen");
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(notizen, { recursive: true });
  fs.writeFileSync(path.join(inbox, "2026-06-10 渗液管理与感染预防.md"), "created: 2026-06-10\n渗液管理影响感染预防", "utf8");
  fs.writeFileSync(path.join(inbox, "2026-06-11 夜班恢复要三天.md"), "夜班恢复规律", "utf8");
  const sent = [];
  const queued = [];
  const config = {
    timeZone: "Europe/Berlin",
    workspaceRoot: "/workspace",
    obsidianVaultDir: vault,
    knowledgeInboxFolder: "01. ⚪ Wissenskarte/00. Knowledge Inbox",
    knowledgeFolder: "01. ⚪ Wissenskarte",
    notizenFolder: "02. 🟡 Notizen",
    digestionStateFile: path.join(state, "digestion.json"),
    digestionHour: 21,
    digestionCheckIntervalMs: 1,
  };
  const service = new DigestionService({
    config,
    channelAdapter: {
      getKnownContextTokens: () => ({ jane: "ctx" }),
      async sendText(p) { sent.push(p.text); },
    },
    sessionStore: { buildBindingKey: () => "b", getActiveWorkspaceRoot: () => "/workspace" },
    systemMessageQueue: { enqueue: (m) => { queued.push(m); return m; }, hasPendingForAccount: () => false },
  });
  // resolveTarget needs a sender; stub via default-targets through sessionStore/contextTokens
  service.resolveTarget = () => ({ senderId: "jane", workspaceRoot: "/workspace" });
  return { vault, service, sent, queued, config };
}

test("offers a numbered list on Sunday evening, once per week", async () => {
  const { service, sent } = makeFixture();
  // 2026-06-14 is a Sunday, 21:30
  const r1 = await service.check({ accountId: "a" }, new Date("2026-06-14T21:30:00+02:00"));
  assert.equal(r1.offered, true);
  assert.equal(r1.count, 2);
  assert.match(sent[0], /可以升级成概念卡/);
  assert.match(sent[0], /1\. 2026-06-10 渗液管理与感染预防/);
  assert.match(sent[0], /升级 1 3/);

  service.lastCheckAtMs = 0;
  const r2 = await service.check({ accountId: "a" }, new Date("2026-06-14T22:30:00+02:00"));
  assert.equal(r2.offered, false);
  assert.equal(sent.length, 1);
});

test("does not offer on a weekday or before the hour", async () => {
  const { service } = makeFixture();
  assert.equal((await service.check({ accountId: "a" }, new Date("2026-06-13T21:30:00+02:00"))).offered, false);
  const { service: s2 } = makeFixture();
  assert.equal((await s2.check({ accountId: "a" }, new Date("2026-06-14T19:00:00+02:00"))).offered, false);
});

test("digit reply maps to chosen files and queues a promotion trigger", async () => {
  const { service, queued } = makeFixture();
  await service.check({ accountId: "a" }, new Date("2026-06-14T21:30:00+02:00"));

  const result = service.handleReply("1", new Date("2026-06-14T21:40:00+02:00"));
  assert.equal(result.action, "promote");
  assert.equal(result.chosen.length, 1);
  assert.match(result.chosen[0].title, /渗液管理/);

  // promoted notes are not re-offered next week
  service.lastCheckAtMs = 0;
  const next = await service.check({ accountId: "a" }, new Date("2026-06-21T21:30:00+02:00"));
  // only the un-chosen note remains as a candidate
  assert.equal(next.count, 1);
});

test("skip dismisses all candidates and they never come back", async () => {
  const { service } = makeFixture();
  await service.check({ accountId: "a" }, new Date("2026-06-14T21:30:00+02:00"));
  const result = service.handleReply("跳过", new Date("2026-06-14T21:40:00+02:00"));
  assert.equal(result.action, "skip");
  service.lastCheckAtMs = 0;
  const next = await service.check({ accountId: "a" }, new Date("2026-06-21T21:30:00+02:00"));
  assert.equal(next.offered, false);
});

test("handleReply returns null without a pending offer", () => {
  const { service } = makeFixture();
  assert.equal(service.handleReply("1 3", new Date()), null);
});

test("parseDigestionReply handles digits, 全部, 跳过, junk", () => {
  assert.deepEqual(parseDigestionReply("1 3", 4).indices, [1, 3]);
  assert.deepEqual(parseDigestionReply("升级 1 3", 4).indices, [1, 3]);
  assert.deepEqual(parseDigestionReply("知识 2", 4).indices, [2]);
  assert.deepEqual(parseDigestionReply("全部", 3).indices, [1, 2, 3]);
  assert.deepEqual(parseDigestionReply("全部升级", 3).indices, [1, 2, 3]);
  assert.deepEqual(parseDigestionReply("升级 全部", 3).indices, [1, 2, 3]);
  assert.equal(parseDigestionReply("跳过", 3).skip, true);
  assert.equal(parseDigestionReply("今天好累啊不想弄这个我去睡了晚安", 3), null);
  assert.equal(parseDigestionReply("9", 3), null);
});

test("promotion trigger mandates concept-note discipline and MOC update", () => {
  const text = buildPromotionTrigger([{ path: "/v/note.md", title: "x" }], { knowledgeFolder: "01. ⚪ Wissenskarte" });
  assert.match(text, /原子概念笔记/);
  assert.match(text, /cyberboss_obsidian_note_write/);
  assert.match(text, /知识地图/);
  assert.match(text, /no_deepseek_fallback=true/);
});
