# Missing Context Queue

Missing Context Queue asks for a small amount of structured evidence when the
day would otherwise be hard to review. It is not a Daily Note input workflow and
does not ask for open-ended journaling.

## Purpose

CyberBoss should keep Obsidian as output, not as manual input. When key context
is missing, CyberBoss asks one short multiple-choice question so Daily Review,
Weekly Review, Monthly Review, and Pattern Ledger have better evidence.

## What It Can Ask

- Why Level A habits were not completed.
- Overall energy score.
- Overall mood score.
- Recovery status after night shift, sleep debt, low energy, or body discomfort.

It avoids low-value details and records `unknown` when the user does not answer
within the response window.

## Anti-Spam Rules

- At most `CYBERBOSS_MISSING_CONTEXT_DAILY_MAX_QUESTIONS`, capped at 3.
- Only one open question at a time.
- Does not ask before `CYBERBOSS_MISSING_CONTEXT_FIRST_PROMPT_HOUR`.
- Does not ask while an after-shift fatigue rating question is unanswered.
- If the user does not answer, the question expires to `unknown` instead of
  being repeatedly asked.

## Telegram Usage

CyberBoss sends a question like:

```text
今天 Sport、Deutsch 还没有记录，主要卡在哪里？

1. 太累
2. 没时间
3. 忘记
4. 情绪不好
5. 不想做
6. 其他

你可以只回数字。我只是补一条复盘需要的关键上下文，不展开问。
```

Reply with only a number, for example:

```text
1
```

CyberBoss writes the structured answer to `missing-context-state.json` and
acknowledges it briefly.

## Configuration

```dotenv
CYBERBOSS_MISSING_CONTEXT_ENABLED=true
CYBERBOSS_MISSING_CONTEXT_STATE_FILE=~/.cyberboss/missing-context-state.json
CYBERBOSS_MISSING_CONTEXT_CHECK_INTERVAL_MS=300000
CYBERBOSS_MISSING_CONTEXT_DAILY_MAX_QUESTIONS=3
CYBERBOSS_MISSING_CONTEXT_FIRST_PROMPT_HOUR=12
CYBERBOSS_MISSING_CONTEXT_RESPONSE_WINDOW_MS=21600000
```

## Data Flow

```text
Telegram answer
-> missing-context-state.json
-> Daily State Engine
-> Daily / Weekly / Monthly Review
-> Pattern Ledger evidence
```
