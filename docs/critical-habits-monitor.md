# Critical Habits Monitor

Critical Habits Monitor protects a small set of long-term priorities from being
forgotten. It reads timeline events and queues shame-aware system messages.

## Default levels

- Level A, soft rhythm check around 12:30 and guardian check at 20:00:
  Sport, Englisch, Deutsch
- Level B, trailing seven-day check on Tuesday, Thursday, and Sunday at 18:00:
  Praxisanleitung, Wundmanagement, Python
- Level C, statistics only: Pflegewissenschaft, Literature Reading,
  Nursing Digest, Forschung

Level A and Level B reminders explicitly allow a minimum version now,
postponement, or consciously skipping. Missing activity is not treated as
failure.

## Configuration

```bash
CYBERBOSS_CRITICAL_HABITS_ENABLED=true
CYBERBOSS_CRITICAL_HABITS_LEVEL_A_HOUR=20
CYBERBOSS_CRITICAL_HABITS_LEVEL_A_MIDDAY_HOUR=12
CYBERBOSS_CRITICAL_HABITS_LEVEL_A_MIDDAY_MINUTE=30
CYBERBOSS_CRITICAL_HABITS_WAKE_GRACE_MINUTES=120
CYBERBOSS_CRITICAL_HABITS_LEVEL_B_HOUR=18
CYBERBOSS_CRITICAL_HABITS_LEVEL_B_WEEKDAYS=2,4,7
CYBERBOSS_CRITICAL_HABITS_CHECK_INTERVAL_MS=300000
```

Habit lists can be overridden with JSON arrays using:

- `CYBERBOSS_CRITICAL_HABITS_LEVEL_A`
- `CYBERBOSS_CRITICAL_HABITS_LEVEL_B`
- `CYBERBOSS_CRITICAL_HABITS_LEVEL_C`
