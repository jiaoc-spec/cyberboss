# Obsidian Tracker Sync

CyberBoss uses Obsidian Tracker as a visual output layer for habits and state,
not as a manual input surface.

Flow:

```text
Telegram -> CyberBoss Daily Inbox -> Daily Review -> Obsidian Daily Note -> Obsidian Tracker
```

The user should not need to open Obsidian every day to tick boxes. The tracker
is rebuilt from generated Daily Notes.

## What It Tracks

Default boolean habits:

- Level A / foundations: `Sport`, `英语发音`, `英语影子跟读`, `德语语法`, `德语影子跟读`, `德语表达`
- Body / dance / recovery habits: `冥想`, `武当1+2`, `足弓`, `健身`, `基本功`, `成品舞`, `有氧操`, `美容灯`
- Professional growth: `Praxisanleitung`, `Wundmanagement`, `Python`, `Nursing Digest`

Not tracked as habits:

- `Energy`
- `Mood`
- `Shift Fatigue`
- `Screen Time`

These remain CyberBoss state/review metrics. They should be summarized or asked
by CyberBoss when useful, but they should not appear in the habit tracker as
things the user has to "do".

## Conservative Completion Rule

Only explicit completion is written as `true`.

Plans, reminders, intentions, questions, and priority awareness prompts do not
count as completion. Missing or unfinished habits are written as `null`.

This prevents the tracker from turning "I should do sport" or "CyberBoss
reminded me about sport" into a false completed habit.

## Manual Sync

```bash
npm run tracker:sync -- --date 2026-06-11 --days 30
```

The sync updates:

```text
<vault>/.obsidian/plugins/tracker/data.json
```

## Daily Review Integration

After the Daily Review pipeline detects that a daily note contains `## 每日复盘`,
it calls the tracker sync automatically. This keeps weekly/monthly habit grids
current without user maintenance.

## Human-Facing Review Boundary

Daily Review should not describe tracker sync, backend cleanup, raw source
paths, or data-pipeline details. Those are system operations. The review should
focus on self-understanding, habit continuity, recovery, and long-term patterns.
