const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA_VERSION = 1;

const HABITS = [
  {
    id: "sport",
    label: "Sport",
    patterns: [/sport/i, /运动/, /健身/, /workout/i, /training/i, /跑步/, /锻炼/],
  },
  {
    id: "english",
    label: "Englisch",
    patterns: [/englisch/i, /english/i, /英语/],
  },
  {
    id: "german",
    label: "Deutsch",
    patterns: [/deutsch/i, /german/i, /德语/],
  },
];

class HabitExceptionService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.stateFile = this.config.habitExceptionStateFile;
  }

  observeIncoming({ text = "", receivedAt = "" } = {}) {
    const sourceText = normalizeText(text);
    if (!sourceText) {
      return { recorded: [], cleared: [] };
    }
    const now = parseDateOrNow(receivedAt);
    const timeZone = this.timeZone();
    const habits = HABITS.filter((habit) => habit.patterns.some((pattern) => pattern.test(sourceText)));
    if (looksLikeResume(sourceText)) {
      return { recorded: [], cleared: this.clearHabits(habits, now) };
    }
    if (!looksLikePause(sourceText)) {
      return { recorded: [], cleared: [] };
    }
    const startDate = resolveStartDate(sourceText, now, timeZone);
    const untilDate = resolveUntilDate(sourceText, startDate, this.config);
    const reason = inferReason(sourceText);
    const recorded = [];
    if (!habits.length) {
      return { recorded, cleared: [] };
    }
    const state = this.loadState();
    state.exceptions = Array.isArray(state.exceptions) ? state.exceptions : [];
    for (const habit of habits) {
      const entry = {
        id: `habit-exception:${habit.id}:${crypto.randomUUID()}`,
        habitId: habit.id,
        label: habit.label,
        status: "paused",
        reason,
        startDate,
        untilDate,
        sourceText,
        createdAt: now.toISOString(),
      };
      state.exceptions.push(entry);
      recorded.push(entry);
    }
    state.exceptions = pruneExceptions(state.exceptions, localDate(now, timeZone));
    this.saveState(state);
    return { recorded, cleared: [] };
  }

  activeFor({ habitId = "", date = "", now = new Date() } = {}) {
    const normalizedHabitId = normalizeHabitId(habitId);
    if (!normalizedHabitId) {
      return null;
    }
    const targetDate = normalizeDate(date) || localDate(now, this.timeZone());
    const state = this.loadState();
    const active = (state.exceptions || [])
      .filter((entry) => entry?.status === "paused")
      .filter((entry) => normalizeHabitId(entry.habitId || entry.label) === normalizedHabitId)
      .filter((entry) => targetDate >= entry.startDate && targetDate <= entry.untilDate)
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
    return active[0] || null;
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return {
        schemaVersion: parsed?.schemaVersion || SCHEMA_VERSION,
        exceptions: Array.isArray(parsed?.exceptions) ? parsed.exceptions : [],
      };
    } catch {
      return { schemaVersion: SCHEMA_VERSION, exceptions: [] };
    }
  }

  clearHabits(habits, now = new Date()) {
    if (!habits.length) {
      return [];
    }
    const ids = new Set(habits.map((habit) => normalizeHabitId(habit.id)));
    const state = this.loadState();
    const cleared = [];
    state.exceptions = (state.exceptions || []).map((entry) => {
      if (entry?.status !== "paused" || !ids.has(normalizeHabitId(entry.habitId || entry.label))) {
        return entry;
      }
      const updated = {
        ...entry,
        status: "cleared",
        clearedAt: now.toISOString(),
      };
      cleared.push(updated);
      return updated;
    });
    if (cleared.length) {
      this.saveState(state);
    }
    return cleared;
  }

  saveState(state) {
    if (!this.stateFile) {
      return;
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      exceptions: Array.isArray(state?.exceptions) ? state.exceptions : [],
    }, null, 2)}\n`, "utf8");
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }
}

function looksLikePause(text) {
  const normalized = normalizeText(text);
  if (!/(不运动|不想运动|先不运动|暂停运动|运动.*(?:暂停|先不|不想|不做|休息|延期)|(?:暂停|先不|不想|不做|休息|延期).{0,12}(运动|sport|健身|workout|training)|不练.{0,8}(英语|德语|english|deutsch)|(?:英语|德语|english|deutsch).{0,12}(?:暂停|先不|不想|不练|延期))/i.test(normalized)) {
    return false;
  }
  return /(这几天|最近|这段时间|今天|明天|这周|本周|暂时|先|目前|现在|等.+再说|延期|暂停|不想|不做|不练|休息)/i.test(normalized);
}

function looksLikeResume(text) {
  return /(恢复|重新开始|可以.*(?:运动|sport|健身|workout|training)|开始.*(?:运动|sport|健身|workout|training)|resume|restart)/i.test(normalizeText(text));
}

function inferReason(text) {
  if (/(天热|太热|热|高温|闷热|hot|heat)/i.test(text)) {
    return "heat";
  }
  if (/(累|疲惫|困|没力气|不在状态|exhausted|tired)/i.test(text)) {
    return "fatigue";
  }
  if (/(疼|痛|不舒服|生理期|大姨妈|period)/i.test(text)) {
    return "body_discomfort";
  }
  return "user_choice";
}

function resolveStartDate(text, now, timeZone) {
  const today = localDate(now, timeZone);
  if (/明天/.test(text)) {
    return addDaysText(today, 1);
  }
  return today;
}

function resolveUntilDate(text, startDate, config = {}) {
  if (/(这周|本周)/.test(text)) {
    return endOfIsoWeek(startDate);
  }
  if (/明天/.test(text) && !/(这几天|最近|这段时间)/.test(text)) {
    return startDate;
  }
  if (/今天/.test(text) && !/(这几天|最近|这段时间)/.test(text)) {
    return startDate;
  }
  const days = Number.isInteger(config.habitExceptionDefaultPauseDays)
    ? config.habitExceptionDefaultPauseDays
    : 3;
  return addDaysText(startDate, Math.max(1, days));
}

function normalizeHabitId(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return "";
  if (/sport|运动|健身|workout|training|跑步|锻炼/.test(text)) return "sport";
  if (/english|englisch|英语/.test(text)) return "english";
  if (/german|deutsch|德语/.test(text)) return "german";
  return text.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
}

function pruneExceptions(exceptions, today) {
  const cutoff = addDaysText(today, -14);
  return exceptions.filter((entry) => normalizeDate(entry?.untilDate) >= cutoff).slice(-200);
}

function endOfIsoWeek(dateText) {
  const date = new Date(`${dateText}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + (7 - day));
  return date.toISOString().slice(0, 10);
}

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDate(date, timeZone) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseDateOrNow(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

function normalizeDate(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  HabitExceptionService,
  normalizeHabitId,
};
