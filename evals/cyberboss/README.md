# CyberBoss Evals

This folder is the local validation gate for CyberBoss behavior before using
SkillOpt or another optimizer.

SkillOpt is useful here as a skill and prompt optimizer. It should not be used
as blind model training on Jane's raw private chats. The safer workflow is:

1. Add real failure cases here as small deterministic examples.
2. Run `npm run eval:cyberboss`.
3. Only let optimizers edit skills, prompts, or rules when the eval gate stays
   green.
4. Promote only validated behavior into the live bot.

## Case Types

- `current_state`: verifies context and busy-state understanding.
- `tracker`: verifies Habit Tracker extraction.
- `periodic`: verifies weekly/monthly review cadence.
- `source_guard`: verifies source-level safety guardrails exist.
- `reply_quality`: optional response checks. Pass a JSONL response file with
  `--responses path/to/responses.jsonl`, one row per `{ "id": "...", "response": "..." }`.

## Add A Real Failure

Add one JSON object per line to `cases.jsonl`. Prefer concrete screenshots or
real Telegram phrases. Keep private content minimal, but preserve the exact
phrasing that caused CyberBoss to fail.
