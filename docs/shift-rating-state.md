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

CyberBoss can ask in two ways:

- **User-triggered:** Jane says she is off work, e.g. `下班了`, `6:50 下班`, `6点50下班`, `夜班结束了`.
- **Calendar-triggered:** Apple Calendar / Day Operations Plan shows a work shift has ended, no rating exists yet, and the configured after-shift delay has passed.

The state file keeps historical `entries`, not only the latest prompt, so Daily /
Weekly / Monthly Review can use older shift ratings.

## Timing

- `CYBERBOSS_SHIFT_RATING_AUTO_PROMPT_ENABLED`: default `true`.
- `CYBERBOSS_SHIFT_RATING_CHECK_INTERVAL_MS`: default `300000`.
- `CYBERBOSS_SHIFT_RATING_AFTER_SHIFT_DELAY_MINUTES`: default `8`.
- `CYBERBOSS_SHIFT_RATING_AFTER_SHIFT_WINDOW_MINUTES`: default `180`.

The prompt is a single lightweight 0-10 question. Missing Context questions
defer while a shift rating question is still unanswered.

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
