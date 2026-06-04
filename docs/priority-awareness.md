# Priority Awareness Assistant

Priority Awareness helps the user remember an explicitly chosen set of
priorities while there is still time to act. It is not supervision, a fixed
execution order, or a general task manager.

## Behavior

- The model records a shared time boundary with `cyberboss_priority_set`.
- Priority lists are unordered unless the user explicitly gives an order.
- Clear completion messages and Timeline events can mark matching priorities as
  completed.
- Future Events and Apple Calendar provide time boundaries, but are not proof of
  completion.
- Dynamic checkpoints read the latest state before deciding whether a gentle
  awareness message is useful.
- The user can complete, postpone, consciously skip, cancel, or reopen a
  priority.

Level A/B/C remains the importance system:

- Level A priorities are eligible for same-day proactive awareness.
- Level B priorities become same-day priorities only when the user explicitly
  promotes them.
- Level C priorities remain review and trend material unless explicitly
  promoted.

## Configuration

```dotenv
CYBERBOSS_PRIORITY_AWARENESS_ENABLED=true
CYBERBOSS_PRIORITY_AWARENESS_CHECK_INTERVAL_MS=300000
CYBERBOSS_PRIORITY_AWARENESS_COOLDOWN_MS=3600000
CYBERBOSS_PRIORITY_AWARENESS_CHECKPOINT_MINUTES=120,45
```

State is stored in `~/.cyberboss/priority-awareness.json` by default.

## Example

User:

> Sport, Deutsch, and Englisch must be completed before my nap.

CyberBoss resolves the nap boundary from calendar context when needed, then
records the three priorities. When Englisch is later completed, a useful
awareness message may summarize that Sport and Deutsch remain without assigning
an order or applying pressure.
