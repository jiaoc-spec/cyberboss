# Apple Health Shortcuts Inbox

Cyberboss can import Apple Health data through files written by iPhone Shortcuts.

Recommended flow:

```text
Apple Health -> iPhone Shortcuts -> iCloud Drive / Obsidian vault file -> Cyberboss -> Obsidian Daily Note
```

Configure the inbox with:

```dotenv
CYBERBOSS_HEALTH_AUTO_IMPORT=true
CYBERBOSS_HEALTH_INBOX_DIR=/absolute/path/to/iCloud/Health/Inbox
CYBERBOSS_HEALTH_IMPORT_INTERVAL_MS=300000
```

The inbox accepts `.json`, `.txt`, `.md`, and `.csv`. JSON is preferred.

Example JSON file:

```json
{
  "date": "2026-06-03",
  "time": "08:30",
  "source": "Apple Health / Shortcuts",
  "steps": 4321,
  "sleepHours": 7.2,
  "restingHeartRate": 62,
  "exerciseMinutes": 25,
  "activeEnergyKcal": 180,
  "workouts": [
    {
      "type": "Walking",
      "minutes": 25
    }
  ],
  "mood": "optional user-entered value",
  "energy": "optional user-entered value"
}
```

Shortcut outline:

1. Get Health samples for the target period.
2. Calculate totals or averages.
3. Build a Dictionary with stable keys such as `date`, `steps`, `sleepHours`, `restingHeartRate`, and `workouts`.
4. Convert the Dictionary to JSON text.
5. Save the file into the configured inbox, for example `health-2026-06-03.json`.

Cyberboss imports each unchanged file once and records it as `Health 自动记录` in the daily note. Raw capture should stay factual; review and trend interpretation happen later.
