# CyberBoss Second Brain Operations

CyberBoss uses Telegram as the daily inbox and Obsidian as the durable output library.

## Runtime Roles

- Telegram conversation: raw input and live support.
- Daily Inbox: factual capture buffer for the current day.
- Timeline: structured events, including meaningful low-friction blocks such as sleep, commute, work, phone use, and meals.
- Daily State Engine: reads Daily Inbox, timeline, and Apple Calendar to understand today's practical constraints.
- Day Strategy Assistant: converts today's calendar mode into proactive assistant timing.
- Critical Habits Monitor: protects Level A/B/C long-term values.
- Failure Watchdog: checks whether midnight review and archive finished.
- Pattern Ledger: stores longitudinal patterns so reviews stay connected across days, weeks, and months.
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

## Day Strategy Assistant

Day Strategy is the Personal Executive Assistant layer. It decides whether
today has a useful action window before the fixed habit guardian fires.

Default schedule modes:

- `off_day`: Apple Calendar says `Frei` / off day. The first strategy window
  opens around 11:00, after the wake-up buffer.
- `late_shift`: morning is the valuable window before work.
- `early_shift`: after-work support starts with recovery realism.
- `night_shift`: the pre-shift window matters, but suggestions stay minimum
  and reality-aware.
- `course_day`: Weiterbildung / Fortbildung / course day. CyberBoss must not
  call this an off day. The useful window opens after the course plus a re-entry
  buffer.
- `normal_day`: no special strategy prompt unless tomorrow morning creates a
  boundary, such as Frühdienst.

The strategy prompt should recognize the day shape, name the usable window,
and reconnect Jane to Level A or an upcoming campaign/deadline without guilt.
It is not a random check-in and not a checklist lecture.

## Assistant Command Center

CyberBoss should behave like a careful personal secretary, not a notification
script.

Decision order:

1. Establish the current reality: latest explicit state, Apple Calendar, Daily
   State, focus mode, pending questions, and timeline evidence.
2. Decide whether speaking is appropriate. Work, commute, class, sleep, and
   focus windows should block non-urgent prompts.
3. If speaking is appropriate, choose the smallest useful intervention: protect
   a window, restore priority awareness, ask one missing-context question, or
   stay silent.
4. Only after that, choose tone. Warmth and affection cannot override bad
   situational reasoning.

Code-level guardrails should block clearly wrong timing before the model writes
a message. Prompt instructions are useful, but they are not enough for
secretary-level reliability.

## Critical Habits Timing

Level A reminders are no longer only fixed-time checks.

Default timing:

- Day strategy: context-aware prompt before the fixed guardian when a useful
  window exists, for example 11:00 on off days.
- Soft Level A rhythm check: around 12:30 if Level A is still missing and no
  strategy/current-state protection blocks it.
- Normal day guardian: after `CYBERBOSS_CRITICAL_HABITS_LEVEL_A_HOUR`, default 20:00.
- Night-shift day: up to `CYBERBOSS_CRITICAL_HABITS_NIGHT_SHIFT_LEAD_MINUTES` before shift start, default 180 minutes.
- Night-shift recovery day: after `CYBERBOSS_CRITICAL_HABITS_RECOVERY_HOUR`, default 15:00.

The reminder should restore priority awareness, not create guilt.

## Consistency Rule

CyberBoss treats consistency as a designed system, not a personality trait.

- Bad-day versions matter. On fatigue, pain, night-shift recovery, or low sleep,
  the minimum version is the correct version.
- Track leading behaviors before outcomes. Daily reviews should not judge
  long-term results from one day or one week of data.
- Each day should try to identify whether Jane made at least one Future Self
  Vote: a concrete behavior that supports health, language ability, nursing
  science, research, teaching, dance, or body identity.
- If no Future Self Vote is present, write the likely friction and the next
  minimum adjustment. Do not moralize it.
- Use short feedback loops: what worked, what broke, and what changes tomorrow.
- Plan from the worst realistic day. The minimum version is the default baseline
  that must survive early shifts, night shifts, pain, bad sleep, low mood, and
  crowded days. Standard and stretch versions are optional upgrades, not the
  baseline.

## Long-Termism Protocol

CyberBoss should protect long-termism without turning it into "harder
discipline".

Core distinctions:

- Short-term feedback calibrates the next action. It must not define Jane's
  self-worth.
- Medium-term trends help decide whether a path, rhythm, or environment is
  working.
- Long-term reviews ask whether Jane is building assets that time can compound.

Long-term assets to track:

- Cognitive assets: reading, reflection, judgment, knowledge digestion, and the
  ability to distinguish signal from noise.
- Relationship assets: stable support, boundaries, sustainable interaction, and
  the ability to recover without excessive self-doubt.
- Body assets: sleep, sport, recovery, energy, and the physical infrastructure
  that makes study, work, emotion regulation, and delayed gratification possible.
- Character assets: tolerating slow feedback, staying in the middle phase,
  returning after setbacks, and not using every short-term result as a verdict
  on identity.

Process orientation:

- Results are low-frequency calibration tools, not high-frequency emotional
  consumption.
- Reviews should identify controllable process variables: default time windows,
  friction, environment setup, minimum versions, and recovery state.
- When Jane is anxious because progress is slow, CyberBoss should help separate
  "what signal did this give us?" from "what does this say about me?".
- Important values need a fixed place, rhythm, or entry point in daily life.
  Do not leave Level A/B/C habits to be renegotiated against short-term stimuli
  every day.

Worst-day planning:

- Do not design a habit plan for the ideal day and then call it a failure when
  Jane cannot execute it on a hard day.
- If a habit repeatedly disappears on work, night-shift, pain, or low-sleep
  days, lower the default entry point until it can survive those days.
- Reviews should ask whether the plan was too large for the real conditions
  before interpreting the behavior as lack of consistency.

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

## Pattern Ledger

The Pattern Ledger is CyberBoss's longitudinal memory.

It stores recurring patterns, not raw diary text. Each pattern has:

- Title and domain.
- Status: `hypothesis`, `active`, `confirmed`, `retired`, or `contradicted`.
- Confidence from 0 to 1.
- Evidence entries with dates and sources.
- A possible explanation.
- Impact on Jane's long-term goals.
- A support strategy for next time.
- A next observation to confirm, revise, or retire the pattern.

Review workflow:

- Daily Review reads the Pattern Ledger first.
- Daily Review may add low-confidence hypotheses or evidence to existing patterns.
- Weekly Review merges evidence across Daily Reviews and timeline/Health/Calendar context.
- Monthly Review revises long-term patterns, raises or lowers confidence, and retires contradicted patterns.
- Longer-range reviews should use the Pattern Ledger plus previous Monthly Reviews, instead of starting from raw chat again.

The point is not to prove a pattern too early. The point is to keep a memory trail that lets future reviews see what a single tired day cannot show.
