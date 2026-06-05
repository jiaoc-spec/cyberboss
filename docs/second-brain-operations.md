# CyberBoss Second Brain Operations

CyberBoss uses Telegram as the daily inbox and Obsidian as the durable output library.

## Runtime Roles

- Telegram conversation: raw input and live support.
- Daily Inbox: factual capture buffer for the current day.
- Timeline: structured events, including meaningful low-friction blocks such as sleep, commute, work, phone use, and meals.
- Daily State Engine: reads Daily Inbox, timeline, and Apple Calendar to understand today's practical constraints.
- Critical Habits Monitor: protects Level A/B/C long-term values.
- Failure Watchdog: checks whether midnight review and archive finished.
- Codex automations: generate Daily, Weekly, and Monthly Second Brain reviews.

## Daily State Engine

The Daily State Engine is not a diary writer. It is a context layer for decisions.

It currently detects:

- Night shift boundaries from Apple Calendar.
- Night-shift recovery and sleep/rest signals.
- Phone-use, commute, sleep/rest, low-energy, and body-discomfort signals.
- Level A completion state for Sport, Englisch, and Deutsch.
- Career growth signals such as Praxisanleitung, Wundmanagement, Pflegewissenschaft, research, literature, and teaching.
- Body identity signals such as sport, fitness, strength training, jazz dance, and dance.

## Critical Habits Timing

Level A reminders are no longer only fixed-time checks.

Default timing:

- Normal day: after `CYBERBOSS_CRITICAL_HABITS_LEVEL_A_HOUR`, default 20:00.
- Night-shift day: up to `CYBERBOSS_CRITICAL_HABITS_NIGHT_SHIFT_LEAD_MINUTES` before shift start, default 180 minutes.
- Night-shift recovery day: after `CYBERBOSS_CRITICAL_HABITS_RECOVERY_HOUR`, default 15:00.

The reminder should restore priority awareness, not create guilt.

## Failure Watchdog

After midnight, CyberBoss checks the previous day:

- Whether Obsidian Daily Note has a `## 每日复盘` section.
- Whether the note still contains pending/no-timeline markers.
- Whether Daily Inbox was archived.

If something failed, CyberBoss notifies Jane in Telegram.

## Timeline Rule

Timeline should not require a glamorous day.

Even sleep, commute, phone use, work, meals, rest, and recovery blocks are useful because they show where time and energy went.

## Review Rule

Daily, Weekly, and Monthly reviews should be written for Jane, not for backend debugging.

Include:

- Meaningful learning and professional growth.
- Habit continuity and return points.
- Emotional and energy patterns.
- Body, sleep, health, work, and commute patterns when relevant.
- Hypotheses clearly labeled as hypotheses.

Exclude:

- Tool implementation details.
- Raw chat boilerplate.
- Debug logs.
- "User said" style noise.
- Low-value sync/export messages unless they reveal a real pattern.
