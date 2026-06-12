# Day Strategy Assistant

Day Strategy Assistant is the layer that turns calendar context into assistant
behavior.

It answers the question:

> What kind of day is this, and when is the useful window to protect Jane's
> long-term values?

## Why It Exists

Critical Habits Monitor knows what matters.

Daily State Engine knows what happened and what is on the calendar.

Day Strategy connects them. Without it, CyberBoss can know that Apple Calendar
says `Frei` but still behave like a passive recorder.

## Schedule Modes

- `off_day`: Apple Calendar shows a free day, usually `Frei`.
- `early_shift`: Frühdienst / early shift.
- `late_shift`: Spätdienst / late shift.
- `night_shift`: Nachtdienst / night shift.
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

## Relationship To Other Modules

- Daily State supplies the schedule mode and Level A completion.
- Critical Habits still protects the evening guardian boundary.
- Priority Awareness handles user-declared deadlines, such as "before sleep".
- Playbook remains only for explicit if-then defaults, not wake-up agenda.
