const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  DAILY_REVIEW_SECTION_PATTERN,
  DAILY_REVIEW_PENDING_PATTERN,
} = require("./daily-state-service");

const OBSIDIAN_ICLOUD_BASE = path.join(
  os.homedir(),
  "Library/Mobile Documents/iCloud~md~obsidian/Documents"
);

const DAILY_NOTE_CANDIDATES = [
  "03. 🔵 Tagebuch/01. 日记",
  "Daily Notes",
  "dailies",
  "Journal",
  "日记",
];

function resolveObsidianDailyDir(configured) {
  if (configured) return configured;
  try {
    const vaults = fs.readdirSync(OBSIDIAN_ICLOUD_BASE);
    for (const vault of vaults) {
      for (const candidate of DAILY_NOTE_CANDIDATES) {
        const dir = path.join(OBSIDIAN_ICLOUD_BASE, vault, candidate);
        if (fs.existsSync(dir)) return dir;
      }
    }
  } catch {}
  return "";
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function countNonEmptyLines(text) {
  if (!text) return 0;
  return text.split("\n").filter((l) => l.trim()).length;
}

function checkWatchdog(stateDir, date) {
  const data = readJsonSafe(path.join(stateDir, "failure-watchdog-state.json"));
  if (!data) return { found: false, ok: null, checkedAt: null };
  const entry = data.checked?.[`daily-review:${date}`];
  if (!entry) return { found: false, ok: null, checkedAt: null };
  return { found: true, ok: Boolean(entry.ok), checkedAt: entry.checkedAt || null };
}

function checkInbox(stateDir, date) {
  const inboxFile = path.join(stateDir, "daily-inbox", `${date}.md`);
  const archiveFile = path.join(stateDir, "daily-inbox-archive", `${date}.md`);
  for (const [filePath, archived] of [[inboxFile, false], [archiveFile, true]]) {
    const text = readFileSafe(filePath);
    if (text !== null) {
      return { found: true, archived, lineCount: countNonEmptyLines(text), filePath };
    }
  }
  return { found: false, archived: false, lineCount: 0, filePath: inboxFile };
}

function checkObsidianNote(obsidianDailyDir, date) {
  if (!obsidianDailyDir) {
    return { found: false, hasPlaceholders: false, hasReviewContent: false, filePath: null };
  }
  const filePath = path.join(obsidianDailyDir, `${date}.md`);
  const text = readFileSafe(filePath);
  if (text === null) {
    return { found: false, hasPlaceholders: false, hasReviewContent: false, filePath };
  }
  const hasPlaceholders = DAILY_REVIEW_PENDING_PATTERN.test(text);
  const hasReviewContent = DAILY_REVIEW_SECTION_PATTERN.test(text) && !hasPlaceholders;
  return { found: true, hasPlaceholders, hasReviewContent, filePath };
}

function checkMissingContext(stateDir, date) {
  const data = readJsonSafe(path.join(stateDir, "missing-context-state.json"));
  if (!data) return { found: false, answered: 0, total: 0, fields: [] };
  const dayData = data.days?.[date];
  if (!dayData) return { found: false, answered: 0, total: 0, fields: [] };
  const questions = Array.isArray(dayData.questions) ? dayData.questions : [];
  const answered = questions.filter((q) => q.status === "answered");
  return {
    found: questions.length > 0,
    answered: answered.length,
    total: questions.length,
    fields: answered.map((q) => `${q.field}=${q.answerLabel || q.answerKey}`),
  };
}

function checkCriticalHabits(stateDir, date) {
  const data = readJsonSafe(path.join(stateDir, "critical-habits-state.json"));
  if (!data) return { found: false, entries: [] };
  const sent = data.sent || {};
  const entries = Object.keys(sent)
    .filter((k) => k.includes(`:${date}:`))
    .map((k) => {
      const parts = k.split(":");
      return { level: parts[0], habit: parts[2] };
    });
  return { found: entries.length > 0, entries };
}

function checkCalendar(stateDir, date) {
  const data = readJsonSafe(path.join(stateDir, "apple-calendar-cache.json"));
  if (!data) return { found: false, total: 0, nonPhone: [], shiftType: null };
  const items = Array.isArray(data) ? data : (data.events || data.entries || []);
  const dayEvents = items.filter((e) => String(e.start || "").slice(0, 10) === date);
  const nonPhone = dayEvents.filter((e) => !String(e.title || "").includes("刷手机"));
  const arbeit = nonPhone.filter((e) => e.calendar === "Arbeit");
  const shiftType = arbeit.length > 0 ? arbeit[0].title : null;
  return {
    found: dayEvents.length > 0,
    total: dayEvents.length,
    nonPhone: nonPhone.map((e) => `${e.calendar}: ${e.title}`).slice(0, 5),
    shiftType,
  };
}

function checkReviewStatus({ stateDir, obsidianDailyNoteDir, date }) {
  const resolvedObsidianDir = resolveObsidianDailyDir(obsidianDailyNoteDir);
  return {
    date,
    watchdog: checkWatchdog(stateDir, date),
    inbox: checkInbox(stateDir, date),
    obsidian: checkObsidianNote(resolvedObsidianDir, date),
    missingContext: checkMissingContext(stateDir, date),
    criticalHabits: checkCriticalHabits(stateDir, date),
    calendar: checkCalendar(stateDir, date),
  };
}

function deriveOverall(result) {
  const { watchdog, inbox, obsidian } = result;
  if (!inbox.found) return "❌ MISSING — no Daily Inbox for this date";
  if (obsidian.hasReviewContent) return "✅ COMPLETE";
  if (obsidian.hasPlaceholders) return "⚠️  INCOMPLETE — Daily Review not yet generated";
  if (!obsidian.found) return "⚠️  INCOMPLETE — Obsidian note not found";
  if (watchdog.found && !watchdog.ok) return "⚠️  INCOMPLETE — watchdog marked failed";
  return "❓ UNKNOWN";
}

function formatStatusReport(result) {
  const { date, watchdog, inbox, obsidian, missingContext, criticalHabits, calendar } = result;
  const lines = [`📅 Daily Review Status: ${date}`, ""];

  if (watchdog.found) {
    const icon = watchdog.ok ? "✅" : "❌";
    const when = watchdog.checkedAt ? ` (checked ${watchdog.checkedAt.slice(0, 16)})` : "";
    lines.push(`${icon} Watchdog: ${watchdog.ok ? "ok" : "failed"}${when}`);
  } else {
    lines.push("⚠️  Watchdog: no entry");
  }

  if (inbox.found) {
    const tag = inbox.archived ? " [archived]" : "";
    lines.push(`✅ Daily Inbox: ${inbox.lineCount} lines${tag}`);
  } else {
    lines.push("❌ Daily Inbox: not found");
  }

  if (calendar.found) {
    const shift = calendar.shiftType ? ` | shift: ${calendar.shiftType}` : "";
    lines.push(`✅ Calendar: ${calendar.total} events${shift}`);
  } else {
    lines.push("⚠️  Calendar: no events");
  }

  if (missingContext.found) {
    const fieldSummary = missingContext.fields.length ? ` (${missingContext.fields.join(", ")})` : "";
    lines.push(`✅ Missing Context: ${missingContext.answered}/${missingContext.total} answered${fieldSummary}`);
  } else {
    lines.push("⚠️  Missing Context: no data");
  }

  if (criticalHabits.found) {
    const summary = criticalHabits.entries.map((e) => `${e.level}:${e.habit}`).join(", ");
    lines.push(`✅ Critical Habits: ${summary}`);
  } else {
    lines.push("⚠️  Critical Habits: no entries");
  }

  lines.push("");
  if (!obsidian.filePath) {
    lines.push("⚠️  Obsidian: path not configured (set CYBERBOSS_OBSIDIAN_DAILY_DIR)");
  } else if (!obsidian.found) {
    lines.push(`❌ Obsidian Note: not found\n   ${obsidian.filePath}`);
  } else if (obsidian.hasReviewContent) {
    lines.push(`✅ Obsidian Note: complete\n   ${obsidian.filePath}`);
  } else if (obsidian.hasPlaceholders) {
    lines.push(`⚠️  Obsidian Note: placeholder only\n   ${obsidian.filePath}`);
  } else {
    lines.push(`📝 Obsidian Note: exists (status unclear)\n   ${obsidian.filePath}`);
  }

  lines.push("");
  lines.push(`Overall: ${deriveOverall(result)}`);

  return lines.join("\n");
}

module.exports = { checkReviewStatus, formatStatusReport, resolveObsidianDailyDir };
