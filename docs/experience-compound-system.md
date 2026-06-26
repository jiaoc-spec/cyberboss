# Experience Compound System

CyberBoss adapts the "personal experience compounding" idea to Jane's
existing Second Brain. The goal is not to copy a manual Obsidian tagging
workflow. The goal is to make Daily / Weekly / Monthly Reviews reusable.

## Principle

Daily Review is not the final destination.

The flow is:

```text
Daily Review
-> Experience Ledger
-> repeated themes
-> action guide candidates
-> action guides
-> just-in-time recall
```

This keeps the original essence:

- experience is extracted after review;
- related experience is aggregated by theme;
- repeated experience becomes visible;
- enough evidence can become a practical action guide;
- future similar situations can recall the old lesson.

## What It Does Not Do

- It does not store raw Telegram chat.
- It does not turn every Daily Review sentence into a card.
- It does not rely on Jane manually filling Daily Notes.
- It does not use free-form Obsidian tags as the primary source of truth.
- It does not create action guides from one isolated event.

## Data Model

Local state:

```text
~/.cyberboss/experience-ledger.json
```

Each experience has:

- `date`
- `domain`
- `type`: `principle`, `experience`, or `insight`
- `theme` / `themeKey`
- `situation`
- `lesson`
- `nextAction`
- `evidence`
- `source`
- `sourcePath`
- `status`

Controlled domains:

- `learning_method`
- `work_nursing`
- `body_energy`
- `emotion_relationship`
- `executive_function`
- `long_term_identity`
- `language`
- `career`
- `health`
- `other`

Status progression:

```text
seed
-> recurring
-> guide_candidate
-> guide_created
```

By default, a theme becomes `guide_candidate` after 3 related experience
items.

## Tools

- `cyberboss_experience_ledger_read`
- `cyberboss_experience_record`
- `cyberboss_experience_guide_create`
- `cyberboss_experience_dashboard_update`

## Review Integration

Daily Review:

- extracts 0-3 high-signal reusable experiences;
- records them with `cyberboss_experience_record`;
- skips low-value logistics and backend details.

Weekly Review:

- reads the Experience Ledger;
- merges repeated weekly themes;
- may create at most one action guide if a candidate is clearly useful.

Monthly Review:

- audits guide candidates;
- may create 1-3 action guides from repeated evidence;
- refreshes the Obsidian dashboard.

## Obsidian Output

Dashboard path:

```text
01. ⚪ Wissenskarte/00. Experience Compound Dashboard.md
```

This page is CyberBoss-managed. It shows:

- today's principle;
- total experience count;
- principle / experience / insight counts;
- action guide candidates;
- created action guides;
- domain aggregation.

## Just-in-time Recall

Experience Ledger entries and action guides are included in
Just-in-time Insight Recall. When Jane faces a similar situation, CyberBoss
can recall a proven personal lesson instead of improvising generic advice.

Example:

```text
Jane: 我夜班后完全不想动。

CyberBoss can recall:
夜班后不要按理想日安排任务，先做最小版本。
```

## Safety Rules

- If there is no reusable lesson, record nothing.
- If the evidence is thin, keep the item as `seed`.
- If the lesson is speculative, mark it as an insight, not a proven rule.
- Do not expose ledger operations in normal Telegram replies.
- Do not use the dashboard to judge Jane; it is a reusable memory asset.
