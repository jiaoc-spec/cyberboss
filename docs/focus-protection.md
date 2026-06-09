# Focus Protection Mode

Focus Protection Mode is a temporary guard around an active task. It does not
replace Priority Awareness, Critical Habits, Pattern Ledger, reminders, or the
timeline. It only protects a declared focus window from non-urgent interruptions.

## Start Focus

Telegram natural language examples:

- `开始英语25分钟`
- `我要学德语30分钟`
- `我现在运动40分钟`
- `开始 Python 30分钟`
- `我要专注到18:00`
- `不要打扰我到17:30`

Command examples:

- `/focus 25 Englisch`
- `/focus until 18:00 Deutsch`
- `/focus cancel`

## Behavior

- Writes the active session to `focus-protection-state.json`.
- Schedules one completion reminder at the focus end time.
- Pauses non-urgent reminders, random check-ins, Critical Habits, and ordinary
  Priority Awareness prompts while focus is active.
- Allows Priority Awareness only when a hard boundary is very close, using
  `CYBERBOSS_PRIORITY_AWARENESS_BOUNDARY_BUFFER_MINUTES`.
- At the end, asks only whether the current focus task was completed.
- If completed, writes a focus event to Timeline.
- If cancelled, exits focus without deleting historical sessions.

## Configuration

```dotenv
CYBERBOSS_FOCUS_PROTECTION_ENABLED=true
CYBERBOSS_FOCUS_PROTECTION_STATE_FILE=~/.cyberboss/focus-protection-state.json
CYBERBOSS_FOCUS_PROTECTION_REMINDER_SNOOZE_MS=300000
```

## Telegram Test

1. Send `开始英语25分钟`.
2. Confirm the bot replies that Englisch Focus started.
3. During the 25 minutes, normal random check-ins and Level A reminders should
   stay silent.
4. At the end, the bot should ask only whether Englisch was completed.
5. Reply `完成`.
6. Confirm the timeline contains a `Focus: Englisch` event.
7. Send `/focus cancel` during another focus session to verify cancellation.
