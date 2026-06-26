const fs = require("fs");
const path = require("path");

const HABITS = [
  { id: "sport", label: "Sport", patterns: [/sport/i, /运动/, /锻炼/, /健身/, /跑步/, /跑了/, /training/i, /workout/i] },
  { id: "english", label: "Englisch", patterns: [/englisch/i, /english/i, /英语/, /英文/] },
  { id: "german", label: "Deutsch", patterns: [/deutsch/i, /german/i, /德语/] },
  { id: "praxisanleitung", label: "Praxisanleitung", patterns: [/praxisanleitung/i, /实践指导/] },
  { id: "wundmanagement", label: "Wundmanagement", patterns: [/wundmanagement/i, /伤口管理/] },
  { id: "python", label: "Python", patterns: [/python/i] },
];

const COMPLETION_PATTERN = /(完成了?|已完成|做完了?|学完了?|练完了?|搞定了?|结束了?|做了|学了|练了|上了|跑了|已经.{0,10}(?:练|学|做|完成)|已.{0,10}(?:练|学|做|完成))/i;
const CORRECTION_COMPLETION_PATTERN = /(不是|不是说|我不是说过).{0,8}(已经|已).{0,16}(练|学|做|完成|搞定)/i;
const NEGATION_PATTERN = /(还没|没有|没做|没学|没练|不想|不做|不练|暂时不|先不|打算|准备|待会|要去)/i;

class HabitObservationService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.stateFile = this.config.habitObservationStateFile;
  }

  observeIncoming({ text = "", receivedAt = "" } = {}) {
    const normalized = normalizeText(text);
    if (!normalized || !this.looksLikeCompletion(normalized)) {
      return { recorded: [] };
    }
    const date = localDate(parseDateOrNow(receivedAt), this.timeZone());
    const habits = matchHabits(normalized);
    if (!habits.length) {
      return { recorded: [] };
    }
    const state = this.loadState();
    state.days = state.days && typeof state.days === "object" ? state.days : {};
    state.days[date] = state.days[date] && typeof state.days[date] === "object" ? state.days[date] : {};
    const recorded = [];
    for (const habit of habits) {
      state.days[date][habit.id] = {
        habitId: habit.id,
        label: habit.label,
        status: "completed",
        completedAt: parseDateOrNow(receivedAt).toISOString(),
        sourceText: normalized,
        updatedAt: new Date().toISOString(),
      };
      recorded.push(state.days[date][habit.id]);
    }
    pruneDays(state.days, date, this.config.habitObservationRetentionDays || 14);
    this.saveState(state);
    return { recorded };
  }

  completedFor({ habitId = "", date = "" } = {}) {
    const id = normalizeHabitId(habitId);
    const day = this.loadState().days?.[date];
    if (!id || !day) {
      return null;
    }
    return day[id]?.status === "completed" ? day[id] : null;
  }

  looksLikeCompletion(text) {
    if (CORRECTION_COMPLETION_PATTERN.test(text)) {
      return true;
    }
    if (!COMPLETION_PATTERN.test(text)) {
      return false;
    }
    return !NEGATION_PATTERN.test(text);
  }

  loadState() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) {
      return { days: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : { days: {} };
    } catch {
      return { days: {} };
    }
  }

  saveState(state) {
    if (!this.stateFile) {
      return;
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }
}

function matchHabits(text) {
  return HABITS.filter((habit) => habit.patterns.some((pattern) => pattern.test(text)));
}

function normalizeHabitId(value) {
  const text = String(value || "").toLowerCase();
  if (/sport|运动|健身|锻炼|training|workout/.test(text)) return "sport";
  if (/english|englisch|英语|英文/.test(text)) return "english";
  if (/german|deutsch|德语/.test(text)) return "german";
  if (/praxisanleitung|实践指导/.test(text)) return "praxisanleitung";
  if (/wundmanagement|伤口管理/.test(text)) return "wundmanagement";
  if (/python/.test(text)) return "python";
  return text.trim();
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseDateOrNow(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function localDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function pruneDays(days, today, retentionDays) {
  const cutoff = Date.parse(`${today}T00:00:00Z`) - Math.max(1, retentionDays) * 86400000;
  for (const date of Object.keys(days || {})) {
    if (Date.parse(`${date}T00:00:00Z`) < cutoff) {
      delete days[date];
    }
  }
}

module.exports = { HabitObservationService };
