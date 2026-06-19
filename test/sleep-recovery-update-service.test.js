const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ObsidianNoteService } = require("../src/services/obsidian-note-service");
const {
  SleepRecoveryUpdateService,
  buildSleepRecoverySummary,
  isSleepEvent,
  resolveTargetDates,
} = require("../src/services/sleep-recovery-update-service");

function makeFixture(events, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sleep-recovery-"));
  const config = {
    timeZone: "Europe/Berlin",
    obsidianVaultDir: path.join(dir, "vault"),
    obsidianDailyFolder: "daily",
    sleepRecoveryUpdateEnabled: true,
    sleepRecoveryUpdateStateFile: path.join(dir, "sleep-state.json"),
    sleepRecoveryUpdateCheckIntervalMs: 1,
    sleepRecoveryUpdateHour: 9,
    sleepRecoveryUpdateMinute: 30,
    sleepRecoveryUpdateLookbackDays: 1,
  };
  const noteDir = path.join(config.obsidianVaultDir, config.obsidianDailyFolder);
  fs.mkdirSync(noteDir, { recursive: true });
  const service = new SleepRecoveryUpdateService({
    config,
    calendar: {
      async read() {
        return { events };
      },
    },
    obsidianNote: new ObsidianNoteService({ config }),
    dayOperationsPlanner: overrides.dayOperationsPlanner,
  });
  return { dir, config, noteDir, service };
}

function writeDaily(noteDir, date) {
  fs.writeFileSync(path.join(noteDir, `${date}.md`), `# ${date} 日记\n\n## 每日复盘\n\n已有复盘。\n`, "utf8");
}

function readDaily(noteDir, date) {
  return fs.readFileSync(path.join(noteDir, `${date}.md`), "utf8");
}

test("sleep recovery waits until the morning supplement window", async () => {
  const { service } = makeFixture([]);
  const result = await service.check(new Date("2026-06-15T09:10:00+02:00"));
  assert.equal(result.action, "before_window");
});

test("normal day sleep is appended to the previous daily note", async () => {
  const { noteDir, service } = makeFixture([
    {
      title: "Sleep",
      calendar: "CalFlow",
      start: "2026-06-14T23:10:00+02:00",
      end: "2026-06-15T06:40:00+02:00",
    },
  ]);
  writeDaily(noteDir, "2026-06-14");

  const result = await service.check(new Date("2026-06-15T10:00:00+02:00"));
  const note = readDaily(noteDir, "2026-06-14");

  assert.equal(result.action, "updated");
  assert.match(note, /## 睡眠 \/ 恢复补全/);
  assert.match(note, /这一天结束后的恢复睡眠/);
  assert.match(note, /23:10-06:40/);
  assert.match(note, /7小时30分钟/);
});

test("night shift post-shift sleep is attributed to the night-shift date", async () => {
  const { noteDir, service } = makeFixture([
    {
      title: "Nachtdienst",
      calendar: "Arbeit",
      start: "2026-06-14T21:30:00+02:00",
      end: "2026-06-15T07:00:00+02:00",
    },
    {
      title: "Sleep",
      calendar: "CalFlow",
      start: "2026-06-15T08:30:00+02:00",
      end: "2026-06-15T13:30:00+02:00",
    },
  ]);
  writeDaily(noteDir, "2026-06-14");

  const result = await service.check(new Date("2026-06-15T14:00:00+02:00"));
  const note = readDaily(noteDir, "2026-06-14");

  assert.equal(result.action, "updated");
  assert.match(note, /班次语境：夜班 \/ Nachtdienst/);
  assert.match(note, /夜班后恢复睡眠/);
  assert.match(note, /08:30-13:30/);
});

test("sleep recovery can use a night-shift operations plan when calendar shift evidence is missing", async () => {
  const { noteDir, service } = makeFixture([
    {
      title: "Sleep",
      calendar: "CalFlow",
      start: "2026-06-15T08:30:00+02:00",
      end: "2026-06-15T13:30:00+02:00",
    },
  ], {
    dayOperationsPlanner: {
      async plan() {
        return {
          dayType: "night_shift",
          scheduleMode: "night_shift",
          fixedBlocks: [
            {
              kind: "night_shift",
              label: "Nachtdienst",
              start: "21:30",
              end: "23:59",
              startMinutes: 1290,
              endMinutes: 1439,
            },
          ],
          recoveryWindows: [
            {
              label: "Night-shift recovery",
              reason: "night_shift_recovery_buffer",
              start: "07:00",
              end: "13:00",
              startMinutes: 420,
              endMinutes: 780,
            },
          ],
          currentPhase: { kind: "open", reason: "test" },
        };
      },
    },
  });
  writeDaily(noteDir, "2026-06-14");

  const result = await service.check(new Date("2026-06-15T14:00:00+02:00"));
  const note = readDaily(noteDir, "2026-06-14");

  assert.equal(result.action, "updated");
  assert.match(note, /班次语境：夜班 \/ Nachtdienst/);
  assert.match(note, /夜班后恢复睡眠/);
  assert.match(note, /08:30-13:30/);
});

test("sleep recovery trusts operations plan over conflicting night-shift calendar text", async () => {
  const { noteDir, service } = makeFixture([
    {
      title: "Nachtdienst",
      calendar: "Arbeit",
      start: "2026-06-14T21:30:00+02:00",
      end: "2026-06-15T07:00:00+02:00",
    },
    {
      title: "Sleep",
      calendar: "CalFlow",
      start: "2026-06-15T08:30:00+02:00",
      end: "2026-06-15T13:30:00+02:00",
    },
  ], {
    dayOperationsPlanner: {
      async plan() {
        return {
          dayType: "early_shift",
          scheduleMode: "early_shift",
          currentPhase: { kind: "open", reason: "test" },
        };
      },
    },
  });
  writeDaily(noteDir, "2026-06-14");

  const result = await service.check(new Date("2026-06-15T14:00:00+02:00"));
  const note = readDaily(noteDir, "2026-06-14");

  assert.equal(result.action, "updated");
  assert.match(note, /班次语境：早班 \/ Frühdienst/);
  assert.doesNotMatch(note, /班次语境：夜班 \/ Nachtdienst/);
  assert.doesNotMatch(note, /夜班后恢复睡眠/);
});

test("sleep recovery can label Weiterbildung from the operations plan", async () => {
  const { noteDir, service } = makeFixture([
    {
      title: "Sleep",
      calendar: "CalFlow",
      start: "2026-06-14T23:10:00+02:00",
      end: "2026-06-15T06:40:00+02:00",
    },
  ], {
    dayOperationsPlanner: {
      async plan() {
        return {
          dayType: "course_day",
          scheduleMode: "course_day",
          currentPhase: { kind: "open", reason: "test" },
        };
      },
    },
  });
  writeDaily(noteDir, "2026-06-14");

  const result = await service.check(new Date("2026-06-15T10:00:00+02:00"));
  const note = readDaily(noteDir, "2026-06-14");

  assert.equal(result.action, "updated");
  assert.match(note, /班次语境：Weiterbildung \/ 课程日/);
});

test("same sleep recovery data is not appended twice", async () => {
  const { noteDir, service } = makeFixture([
    {
      title: "Sleep",
      calendar: "CalFlow",
      start: "2026-06-14T23:10:00+02:00",
      end: "2026-06-15T06:40:00+02:00",
    },
  ]);
  writeDaily(noteDir, "2026-06-14");

  assert.equal((await service.check(new Date("2026-06-15T10:00:00+02:00"))).action, "updated");
  service.lastCheckAtMs = 0;
  assert.equal((await service.check(new Date("2026-06-15T10:30:00+02:00"))).action, "no_update");

  const note = readDaily(noteDir, "2026-06-14");
  assert.equal((note.match(/## 睡眠 \/ 恢复补全/g) || []).length, 1);
});

test("changed sleep recovery data replaces the existing block", async () => {
  const events = [
    {
      title: "Sleep",
      calendar: "CalFlow",
      start: "2026-06-14T23:10:00+02:00",
      end: "2026-06-15T06:40:00+02:00",
    },
  ];
  const { noteDir, service } = makeFixture(events);
  writeDaily(noteDir, "2026-06-14");

  assert.equal((await service.check(new Date("2026-06-15T10:00:00+02:00"))).action, "updated");
  events[0] = {
    ...events[0],
    end: "2026-06-15T07:10:00+02:00",
  };
  service.lastCheckAtMs = 0;
  assert.equal((await service.check(new Date("2026-06-15T10:30:00+02:00"))).action, "updated");

  const note = readDaily(noteDir, "2026-06-14");
  assert.equal((note.match(/## 睡眠 \/ 恢复补全/g) || []).length, 1);
  assert.match(note, /23:10-07:10/);
  assert.doesNotMatch(note, /23:10-06:40/);
});

test("calendar events without valid times are ignored", async () => {
  const { noteDir, service } = makeFixture([
    {
      title: "Sleep",
      calendar: "CalFlow",
      start: "",
      end: "",
    },
    {
      title: "Sleep",
      calendar: "CalFlow",
      start: "2026-06-14T23:10:00+02:00",
      end: "2026-06-15T06:40:00+02:00",
    },
  ]);
  writeDaily(noteDir, "2026-06-14");

  const result = await service.check(new Date("2026-06-15T10:00:00+02:00"));
  const note = readDaily(noteDir, "2026-06-14");

  assert.equal(result.action, "updated");
  assert.match(note, /23:10-06:40/);
});

test("sleep helpers recognize CalFlow style sleep and target previous days", () => {
  assert.equal(isSleepEvent({ title: "Core Sleep", calendar: "CalFlow" }), true);
  assert.deepEqual(resolveTargetDates("2026-06-15", 2), ["2026-06-14", "2026-06-13"]);
});

test("summary separates pre-day and end-of-day sleep for non-night-shift days", () => {
  const sleepEvents = [
    {
      title: "Sleep",
      start: new Date("2026-06-14T00:30:00+02:00"),
      end: new Date("2026-06-14T07:00:00+02:00"),
      durationMinutes: 390,
    },
    {
      title: "Sleep",
      start: new Date("2026-06-14T23:00:00+02:00"),
      end: new Date("2026-06-15T06:00:00+02:00"),
      durationMinutes: 420,
    },
  ];
  const summary = buildSleepRecoverySummary({
    targetDate: "2026-06-14",
    timeZone: "Europe/Berlin",
    sleepEvents,
    shiftEvents: [],
  });
  assert.deepEqual(summary.sections.map((section) => section.label), [
    "进入这一天之前的睡眠",
    "这一天结束后的恢复睡眠",
  ]);
});
