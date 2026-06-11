const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PlaybookService, buildPlaybookTrigger } = require("../src/services/playbook-service");

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-playbook-"));
  return new PlaybookService({
    config: {
      timeZone: "Europe/Berlin",
      playbookFile: path.join(dir, "playbook.json"),
    },
  });
}

test("ships default rules on first use", async () => {
  const service = makeService();
  const { rules } = await service.list();
  assert.ok(rules.length >= 2);
  assert.ok(rules.some((rule) => rule.anchor === "arrived_home" && rule.task === "Sport"));
  assert.ok(rules.some((rule) => rule.anchor === "woke_up" && rule.task === "Deutsch"));
});

test("matchAnchor respects hour window and once-per-day cooldown", () => {
  const service = makeService();

  // arrived_home default window is 8-22
  const evening = new Date("2026-06-11T18:00:00+02:00");
  const rule = service.matchAnchor({ anchor: "arrived_home", now: evening });
  assert.equal(rule.task, "Sport");

  // before the window: no match (woke_up at 4:30 before early shift)
  const earlyMorning = new Date("2026-06-11T04:35:00+02:00");
  assert.equal(service.matchAnchor({ anchor: "woke_up", now: earlyMorning }), null);

  // after recordSent, same anchor stays quiet for the rest of the day
  service.recordSent(rule.id, evening);
  assert.equal(service.matchAnchor({ anchor: "arrived_home", now: new Date("2026-06-11T20:00:00+02:00") }), null);
  // but fires again the next day
  assert.ok(service.matchAnchor({ anchor: "arrived_home", now: new Date("2026-06-12T18:00:00+02:00") }));
});

test("upsert, disable, and remove rules", async () => {
  const service = makeService();
  const rule = await service.upsertRule({
    anchor: "off_work",
    task: "Englisch",
    label: "英语 5 分钟",
    minutes: 5,
    hours: { from: 14, to: 23 },
  });
  assert.ok(rule.id.startsWith("pb_"));
  assert.equal(service.matchAnchor({ anchor: "off_work", now: new Date("2026-06-11T16:00:00+02:00") }).task, "Englisch");

  await service.upsertRule({ ...rule, enabled: false });
  assert.equal(service.matchAnchor({ anchor: "off_work", now: new Date("2026-06-11T16:00:00+02:00") }), null);

  await service.removeRule({ id: rule.id });
  const { rules } = await service.list();
  assert.ok(!rules.some((item) => item.id === rule.id));

  await assert.rejects(() => service.upsertRule({ anchor: "nonsense", task: "X", label: "x" }), /anchor must be one of/);
});

test("trigger text demands a single default and digit start", () => {
  const text = buildPlaybookTrigger(
    { id: "pb_1", anchor: "arrived_home", task: "Sport", label: "运动 10 分钟（最小版）", minutes: 10 },
    "到家了",
    "Jane",
  );
  assert.match(text, /DELIVERY REQUIRED/);
  assert.match(text, /回 1 我帮你开始计时（10 分钟）/);
  assert.match(text, /cyberboss_focus_start/);
  assert.match(text, /no menus, no three choices/);
  assert.match(text, /never re-ask/);
});
