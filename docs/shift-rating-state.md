# Shift Rating State

Shift Rating captures the user's after-shift fatigue score and feeds it into the
daily support system. It is not a separate journaling task.

## Flow

```text
Telegram after-shift report
-> one 0-10 fatigue question
-> shift-rating-state.json
-> Daily State Engine
-> Critical Habits minimum mode
-> Pattern Ledger evidence
-> Daily / Weekly / Monthly Review
```

## Fatigue Bands

- `0-3`: low fatigue
- `4-6`: medium fatigue
- `7-10`: high fatigue

High fatigue changes `DailyState.recommendedMode` to `minimum`.

## Review Guidance

When Daily State includes high after-shift fatigue and Level A habits are still
open, reviews should write this as a practical interpretation:

```text
今天下班疲惫分较高，Level A 采用 minimum mode 更合理。
```

This is a fact-based support adjustment, not an excuse, a criticism, or a fixed
diagnosis. Pattern Ledger may treat repeated cases as low-confidence evidence
that high after-shift fatigue affects Level A completion.
