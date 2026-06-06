const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { WinsService } = require("../src/services/wins-service");

function makeTmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-wins-"));
  return {
    winsLedgerFile: path.join(dir, "wins-ledger.json"),
  };
}

test("records a win with required fields", async () => {
  const service = new WinsService({ config: makeTmpConfig() });
  const win = await service.record({
    task: "Sport",
    domain: "health",
    success_factor: "right_after_work",
  });
  assert.ok(win.id);
  assert.equal(win.task, "Sport");
  assert.equal(win.domain, "health");
  assert.equal(win.success_factor, "right_after_work");
  assert.ok(win.date);
  assert.ok(win.createdAt);
});

test("persists wins to file", async () => {
  const config = makeTmpConfig();
  const service = new WinsService({ config });
  await service.record({ task: "Englisch", domain: "learning", success_factor: "small_chunk" });
  await service.record({ task: "Deutsch", domain: "learning", success_factor: "had_reminder" });
  const data = JSON.parse(fs.readFileSync(config.winsLedgerFile, "utf8"));
  assert.equal(data.wins.length, 2);
  assert.equal(data.schemaVersion, 1);
});

test("query returns all wins when no filter", async () => {
  const config = makeTmpConfig();
  const service = new WinsService({ config });
  await service.record({ task: "Sport", domain: "health", success_factor: "energy_good" });
  await service.record({ task: "Englisch", domain: "learning", success_factor: "energy_good" });
  const result = await service.query({});
  assert.equal(result.wins.length, 2);
});

test("query filters by domain", async () => {
  const config = makeTmpConfig();
  const service = new WinsService({ config });
  await service.record({ task: "Sport", domain: "health", success_factor: "energy_good" });
  await service.record({ task: "Englisch", domain: "learning", success_factor: "had_reminder" });
  const result = await service.query({ domain: "health" });
  assert.equal(result.wins.length, 1);
  assert.equal(result.wins[0].task, "Sport");
});

test("query filters by task", async () => {
  const config = makeTmpConfig();
  const service = new WinsService({ config });
  await service.record({ task: "Sport", domain: "health", success_factor: "energy_good" });
  await service.record({ task: "Sport", domain: "health", success_factor: "right_after_work" });
  await service.record({ task: "Englisch", domain: "learning", success_factor: "had_reminder" });
  const result = await service.query({ task: "Sport" });
  assert.equal(result.wins.length, 2);
});

test("record accepts optional context fields", async () => {
  const config = makeTmpConfig();
  const service = new WinsService({ config });
  const win = await service.record({
    task: "Sport",
    domain: "health",
    success_factor: "right_after_work",
    energy_context: "high",
    shift_context: "day_shift",
    reminder_context: "had_reminder",
    note: "Today felt easy",
  });
  assert.equal(win.energy_context, "high");
  assert.equal(win.note, "Today felt easy");
});
