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
