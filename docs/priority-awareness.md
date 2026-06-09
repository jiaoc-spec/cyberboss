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
- Each priority has a realistic full-version duration estimate. Known defaults
  include Sport `60m`, Deutsch `30m`, and Englisch `25m`; the model can override
  them when the user describes a different version.
- Feasibility checkpoints sum the duration of all open priorities and add a
  preparation buffer before the boundary. This creates a latest practical start
  time instead of relying only on generic countdown reminders.
- Dynamic checkpoints read the latest state before deciding whether a gentle
  awareness message is useful. If the full plan is no longer feasible, the
  assistant should offer a minimum version, postponement, skipping, or a plan
  revision instead of implying that full completion is still realistic.
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
CYBERBOSS_PRIORITY_AWARENESS_BOUNDARY_BUFFER_MINUTES=30
```

State is stored in `~/.cyberboss/priority-awareness.json` by default.

## Example

User:

> Sport, Deutsch, and Englisch must be completed before my nap.

CyberBoss resolves the nap boundary from calendar context when needed, then
records the three priorities. If the nap is at `15:00`, the remaining Sport
`60m` and Deutsch `30m`, plus the default `30m` preparation buffer, make `13:00`
the latest practical start time. A useful awareness message should arrive around
that time without assigning an order or applying pressure.
