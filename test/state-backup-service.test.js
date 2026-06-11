const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { StateBackupService } = require("../src/services/state-backup-service");

function makeStateDir({ withGit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-backup-"));
  fs.writeFileSync(path.join(dir, "pattern-ledger.json"), "{}\n", "utf8");
  if (withGit) {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@test"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  }
  return dir;
}

test("commits a daily snapshot when state changed", async () => {
  const dir = makeStateDir();
  const service = new StateBackupService({
    config: { stateDir: dir, timeZone: "Europe/Berlin", stateBackupHour: 1 },
  });
  fs.writeFileSync(path.join(dir, "pattern-ledger.json"), '{"changed":true}\n', "utf8");

  const result = await service.check(new Date("2026-06-11T02:00:00+02:00"));
  assert.equal(result.backed, true);
  const log = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" });
  assert.match(log, /auto snapshot 2026-06-11/);

  // same day: no second commit
  service.lastCheckAtMs = 0;
  const second = await service.check(new Date("2026-06-11T03:00:00+02:00"));
  assert.equal(second.backed, false);
});

test("stays quiet before the backup hour and without a git repo", async () => {
  const dir = makeStateDir();
  const service = new StateBackupService({
    config: { stateDir: dir, timeZone: "Europe/Berlin", stateBackupHour: 1 },
  });
  assert.equal((await service.check(new Date("2026-06-11T00:30:00+02:00"))).backed, false);

  const noGit = makeStateDir({ withGit: false });
  const service2 = new StateBackupService({
    config: { stateDir: noGit, timeZone: "Europe/Berlin", stateBackupHour: 1 },
  });
  assert.equal((await service2.check(new Date("2026-06-11T02:00:00+02:00"))).backed, false);
});
