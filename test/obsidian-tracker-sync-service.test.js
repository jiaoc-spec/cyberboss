const test = require("node:test");
const assert = require("node:assert/strict");

const { extractTrackerEntries } = require("../src/services/obsidian-tracker-sync-service");

test("tracker extraction does not turn unfinished sport into completion", () => {
  const entries = extractTrackerEntries(`
## 自动统计

- 运动：未完成 / 未记录完成。

## 时间轴数据

\`\`\`json
{
  "date": "2026-06-11",
  "level_a": {
    "sport": "not_recorded",
    "english": "not_recorded",
    "deutsch": "not_recorded"
  },
  "energy_score": 5.5,
  "mood_score": 7.5,
  "screen_time_deduped_minutes": 61
}
\`\`\`
`);

  assert.equal(entries.Sport, null);
  assert.equal(entries["英语发音"], null);
  assert.equal(entries["德语语法"], undefined);
  assert.equal(entries["德语影子跟读"], undefined);
  assert.equal(entries.Energy, undefined);
  assert.equal(entries.Mood, undefined);
  assert.equal(entries["Screen Time"], undefined);
});

test("tracker extraction records explicit completed language habits", () => {
  const entries = extractTrackerEntries(`
## 自动统计

- 学习：英语 25 分钟；Deutsch 未记录。

## 时间轴数据

\`\`\`json
{
  "date": "2026-06-08",
  "level_a": {
    "sport": "not_recorded",
    "english": "completed_25min",
    "deutsch": "not_recorded"
  }
}
\`\`\`
`);

  assert.equal(entries["英语发音"], true);
  assert.equal(entries["德语语法"], undefined);
  assert.equal(entries["德语影子跟读"], undefined);
  assert.equal(entries.Sport, null);
});

test("tracker extraction records requested body and care habits", () => {
  const entries = extractTrackerEntries(`
## 自动统计

- 运动：健身 40 分钟，足弓 10 分钟。
- 护理成长：Nursing Digest 完成。

## 时间轴数据

\`\`\`json
{
  "date": "2026-06-12",
  "habits": {
    "冥想": "completed",
    "德语语法": "completed",
    "美容灯": "completed"
  }
}
\`\`\`
`);

  assert.equal(entries.Sport, true);
  assert.equal(entries["健身"], true);
  assert.equal(entries["足弓"], true);
  assert.equal(entries["冥想"], true);
  assert.equal(entries["德语语法"], true);
  assert.equal(entries["美容灯"], true);
  assert.equal(entries["Nursing Digest"], true);
});

test("tracker extraction treats wudang and foot arch as shaping, not Sport", () => {
  const entries = extractTrackerEntries(`
## 自动统计

- 塑形：武当1+2 完成，足弓 10 分钟。

## 时间轴数据

\`\`\`json
{
  "date": "2026-06-14"
}
\`\`\`
`);

  assert.equal(entries.Sport, undefined);
  assert.equal(entries["骨盆"], true);
  assert.equal(entries["足弓"], true);
});

test("tracker extraction prefers structured tracker completed lists over review prose", () => {
  const entries = extractTrackerEntries(`
## Growth Log

- 英语发音完成了 25 分钟练习。

### Open loops
- Sport：当天没有形成完成记录。
- 德语语法：当天没有形成完成记录。

## 时间轴数据

\`\`\`json
{
  "date": "2026-06-12",
  "tracker": {
    "completed": ["英语发音", "德语影子跟读", "武当1+2", "足弓"],
    "not_completed": ["Sport", "德语语法"]
  }
}
\`\`\`
`);

  assert.equal(entries.Sport, null);
  assert.equal(entries["英语发音"], true);
  assert.equal(entries["德语影子跟读"], true);
  assert.equal(entries["骨盆"], true);
  assert.equal(entries["足弓"], true);
  assert.equal(entries["德语语法"], null);
});

test("regression (2026-06-14): habit names inside the JSON missing arrays must NOT be checked", () => {
  // The real over-check bug: 成品舞/基本功/有氧操 only appeared in the JSON
  // block's nested "missing" arrays and in negated prose, yet got marked done.
  const entries = extractTrackerEntries(`
## 复盘

- 晚间完成了武当1+2和足弓，说明身体连续性还在。
- Sport、英语发音、德语语法、德语影子跟读今天都没有形成完成记录。
- 身体连续性：武当1+2、足弓完成；不计为 Sport。

## 时间轴数据

\`\`\`json
{
  "date": "2026-06-14",
  "tracker": {
    "completed": ["武当1+2", "足弓"],
    "not_completed": ["Sport", "英语发音", "德语语法", "德语影子跟读"]
  },
  "identity_ledger": {
    "dance": { "missing": ["成品舞", "基本功", "有氧操"] }
  }
}
\`\`\`
`);

  assert.equal(entries["骨盆"], true);
  assert.equal(entries["足弓"], true);
  assert.equal(entries.Sport, null);
  assert.equal(entries["英语发音"], null);
  assert.equal(entries["德语语法"], null);
  assert.equal(entries["德语影子跟读"], null);
  // these only appeared in the JSON missing array / nowhere in clean prose
  assert.equal(entries["成品舞"], undefined);
  assert.equal(entries["基本功"], undefined);
  assert.equal(entries["有氧操"], undefined);
});

test("regression (2026-06-15): habit_status missing block leaves nothing checked", () => {
  const entries = extractTrackerEntries(`
## 复盘

- Sport：没有完成记录
- 英语发音：没有完成记录

## 时间轴数据

\`\`\`json
{
  "date": "2026-06-15",
  "habit_status": {
    "Sport": "missing",
    "英语发音": "missing",
    "德语语法": "missing",
    "德语影子跟读": "missing"
  }
}
\`\`\`
`);
  for (const name of ["Sport", "英语发音", "德语语法", "德语影子跟读"]) {
    assert.equal(entries[name], null, `${name} must be not-done`);
  }
  assert.equal(entries["成品舞"], undefined);
  assert.equal(entries["健身"], undefined);
});

test("structuredCompletedHabits returns only structurally-confirmed completions", () => {
  const { structuredCompletedHabits } = require("../src/services/obsidian-tracker-sync-service");
  const completed = structuredCompletedHabits(`
## 时间轴数据
\`\`\`json
{ "tracker": { "completed": ["武当1+2", "足弓"], "not_completed": ["Sport"] },
  "identity_ledger": { "dance": { "missing": ["成品舞"] } } }
\`\`\`
`);
  assert.deepEqual(completed.sort(), ["骨盆", "足弓"].sort());
});
