# Day Strategy Assistant

Day Strategy Assistant is the layer that turns calendar context into assistant
behavior.

It answers the question:

> What kind of day is this, and when is the useful window to protect Jane's
> long-term values?

## Why It Exists

Critical Habits Monitor knows what matters.

Daily State Engine knows what happened and what is on the calendar.

Day Operations Planner turns the daily facts into a background operating plan:
fixed blocks, do-not-disturb windows, recovery buffers, and usable priority
windows.

Day Strategy connects these layers. Without it, CyberBoss can know that Apple
Calendar says `Frei` but still behave like a passive recorder.

## Day Operations Planner

Day Operations Planner is the "secretary looks at the day first" layer.

It writes a small daily plan to `day-operations-plan.json` and exposes it to:

- ordinary Telegram replies, as runtime context;
- Day Strategy, before it chooses a proactive prompt;
- Priority Awareness, before it reminds about user-declared priorities;
- Critical Habits, before direct Level A reminders;
- random check-ins, through the persisted plan file.

The planner does not decide life goals and does not generate chat prose. It
only answers:

- What fixed commitments are on the calendar today?
- Is Jane currently in work, course, focus, recovery, or a usable priority
  window?
- Should non-urgent assistant messages defer right now?
- If speaking is useful, what kind of window is this?

Default config:

```dotenv
CYBERBOSS_DAY_OPERATIONS_PLANNER_ENABLED=true
CYBERBOSS_DAY_OPERATIONS_PLAN_STATE_FILE=~/.cyberboss/day-operations-plan.json
CYBERBOSS_DAY_OPERATIONS_COURSE_RECOVERY_MINUTES=30
CYBERBOSS_DAY_OPERATIONS_SHIFT_RECOVERY_MINUTES=60
CYBERBOSS_DAY_OPERATIONS_PRIORITY_WINDOW_END_HOUR=21
```

## Schedule Modes

- `off_day`: Apple Calendar shows a free day, usually `Frei`.
- `early_shift`: Frühdienst / early shift.
- `late_shift`: Spätdienst / late shift.
- `night_shift`: Nachtdienst / night shift.
- `course_day`: Weiterbildung / Fortbildung / Seminar / Kurs / 网课 / 课程 / 培训.
- `normal_day`: no clear work-shift mode.

## Default Windows

```dotenv
CYBERBOSS_DAY_STRATEGY_ENABLED=true
CYBERBOSS_DAY_STRATEGY_OFF_DAY_FIRST_HOUR=11
CYBERBOSS_DAY_STRATEGY_OFF_DAY_FIRST_MINUTE=0
CYBERBOSS_DAY_STRATEGY_LATE_SHIFT_HOUR=10
CYBERBOSS_DAY_STRATEGY_LATE_SHIFT_MINUTE=30
CYBERBOSS_DAY_STRATEGY_EARLY_SHIFT_HOUR=16
CYBERBOSS_DAY_STRATEGY_EARLY_SHIFT_MINUTE=30
CYBERBOSS_DAY_STRATEGY_WAKE_GRACE_MINUTES=120
CYBERBOSS_DAY_STRATEGY_COURSE_DAY_AFTER_HOUR=16
CYBERBOSS_DAY_STRATEGY_COURSE_DAY_AFTER_MINUTE=0
CYBERBOSS_DAY_STRATEGY_COURSE_DAY_GRACE_MINUTES=30
```

## Behavior

Day Strategy sends at most one prompt per checkpoint per day. It stays quiet
when:

- Focus Mode is active.
- Jane is commuting or at work.
- Jane recently said she is going to sleep.
- Jane is inside the wake-up grace window.
- Apple Calendar says there is a current event.
- There is already a pending system message.

## Off-Day Example

If Apple Calendar says `Frei`, Level A habits are still open, and there is no
current calendar event, CyberBoss should recognize that the day has more
flexible time than a workday.

The message should not say "you failed" or "you must". It should say, in a
natural way, that today has a useful window and suggest one realistic first
block for Sport, Deutsch, Englisch, or a near deadline.

## Course-Day Example

If Apple Calendar says `Weiterbildung zur PA 08:30-15:00`, CyberBoss must not
call the day an off day, even if the timeline also contains `睡眠 / 休息`.

The useful window starts after the course plus a short re-entry buffer. The
message should recognize the course-day shape and then restore priority
awareness for all still-open Level A habits. If Sport is still open, Sport must
remain visible; it can be a 5-10 minute minimum version, but it should not
disappear from the reminder.

## Relationship To Other Modules

- Daily State supplies the schedule mode and Level A completion.
- Critical Habits still protects the evening guardian boundary.
- Priority Awareness handles user-declared deadlines, such as "before sleep".
- Playbook remains only for explicit if-then defaults, not wake-up agenda.
