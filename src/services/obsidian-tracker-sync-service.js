const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_DAILY_FOLDER = "03. 🔵 Tagebuch/01. 日记";

const TRACKED_HABITS = [
  { name: "Sport", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "冥想", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "英语发音", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "德语语法", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "德语影子跟读", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "武当1+2", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "足弓", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "健身", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "基本功", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "成品舞", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "有氧操", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "美容灯", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "Praxisanleitung", type: "boolean", frequency: "week", completionGoal: 2, statsType: "heatmap" },
  { name: "Wundmanagement", type: "boolean", frequency: "week", completionGoal: 1, statsType: "heatmap" },
  { name: "Python", type: "boolean", frequency: "week", completionGoal: 2, statsType: "heatmap" },
  { name: "Nursing Digest", type: "boolean", frequency: "week", completionGoal: 1, statsType: "heatmap" },
];

const REMOVED_DEFAULT_HABIT_NAMES = new Set([
  "Deutsch",
  "Englisch",
  "Pflegewissenschaft",
  "Literature Reading",
  "Forschung",
  "Energy",
  "Mood",
  "Shift Fatigue",
  "Screen Time",
]);

class ObsidianTrackerSyncService {
  constructor({ config } = {}) {
    this.config = config || {};
  }

  sync({ throughDate = "", days = 0 } = {}) {
    if (this.config.obsidianTrackerEnabled === false) {
      return { action: "disabled" };
    }
    const endDate = normalizeDateText(throughDate) || localDateText(new Date(), this.config.timeZone || "UTC");
    const syncDays = Number(days || this.config.obsidianTrackerSyncDays || 90);
    const startDate = addDaysText(endDate, -(Math.max(syncDays, 1) - 1));
    const noteDir = this.resolveDailyDir();
    const trackerDataPath = this.resolveDataFile();
    const tracker = this.loadTrackerData(trackerDataPath);
    tracker.habits = mergeHabits(tracker.habits, TRACKED_HABITS);
    tracker.weekStartsOn = Number.isInteger(tracker.weekStartsOn) ? tracker.weekStartsOn : 1;
    tracker.completionData = tracker.completionData && typeof tracker.completionData === "object"
      ? tracker.completionData
      : {};

    const syncedDates = [];
    for (const date of eachDate(startDate, endDate)) {
      const notePath = path.join(noteDir, `${date}.md`);
      if (!fs.existsSync(notePath)) {
        continue;
      }
      const text = fs.readFileSync(notePath, "utf8");
      const extracted = extractTrackerEntries(text);
      if (Object.keys(extracted).length === 0) {
        continue;
      }
      tracker.completionData[date] = {
        ...(tracker.completionData[date] || {}),
        ...extracted,
      };
      syncedDates.push(date);
    }

    fs.mkdirSync(path.dirname(trackerDataPath), { recursive: true });
    fs.writeFileSync(trackerDataPath, `${JSON.stringify(tracker, null, 2)}\n`, "utf8");
    return {
      action: "synced",
      trackerDataPath,
      noteDir,
      startDate,
      endDate,
      syncedDates,
      habitCount: tracker.habits.length,
    };
  }

  loadTrackerData(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        mySetting: parsed.mySetting || "default",
        habits: Array.isArray(parsed.habits) ? parsed.habits : [],
        completionData: parsed.completionData && typeof parsed.completionData === "object" ? parsed.completionData : {},
        weekStartsOn: Number.isInteger(parsed.weekStartsOn) ? parsed.weekStartsOn : 1,
      };
    } catch {
      return {
        mySetting: "default",
        habits: [],
        completionData: {},
        weekStartsOn: 1,
      };
    }
  }

  resolveDataFile() {
    const configured = String(this.config.obsidianTrackerDataFile || "").trim();
    if (configured) {
      return path.resolve(configured);
    }
    return path.join(
      this.resolveVaultDir(),
      ".obsidian",
      "plugins",
      this.config.obsidianTrackerPluginId || "tracker",
      "data.json",
    );
  }

  resolveDailyDir() {
    return path.join(
      this.resolveVaultDir(),
      this.config.obsidianDailyFolder || DEFAULT_DAILY_FOLDER,
    );
  }

  resolveVaultDir() {
    const configured = String(this.config.obsidianVaultDir || "").trim();
    if (configured) {
      return path.resolve(configured);
    }
    return path.join(
      os.homedir(),
      "Library/Mobile Documents/iCloud~md~obsidian/Documents/Jiao's Obsidian",
    );
  }
}

function mergeHabits(existing, defaults) {
  const result = Array.isArray(existing)
    ? existing
      .filter((habit) => !REMOVED_DEFAULT_HABIT_NAMES.has(habit?.name))
      .map((habit) => ({ ...habit }))
    : [];
  for (const habit of defaults) {
    const index = result.findIndex((item) => item?.name === habit.name);
    if (index >= 0) {
      result[index] = { ...habit, ...result[index] };
    } else {
      result.push({ ...habit });
    }
  }
  return result;
}

function extractTrackerEntries(text) {
  const entries = {};
  const data = extractTimelineData(text);
  const levelA = data?.level_a || data?.levelA || {};
  const habitData = normalizeStructuredHabitData(data);
  setBoolean(entries, "Sport", resolveHabitStatus(valueWithFallback(habitData, "Sport", levelA.sport), text, [
    /(?:运动|Sport|健身|力量训练|有氧操|基本功|成品舞|武当|足弓)[^\n]*(?:已完成|完成|completed|done|\d+\s*分钟)/i,
  ], [
    /(?:运动|Sport)[：:][^\n]*(?:未完成|未记录|not_recorded|not completed)/i,
  ]));
  setBoolean(entries, "冥想", resolveNamedHabit(habitData, text, "冥想", [/冥想|meditation/i]));
  setBoolean(entries, "英语发音", resolveNamedHabit(habitData, text, "英语发音", [/英语发音|English pronunciation|Englisch|Rachel'?s English|Rachel’s English/i], [
    /(?:英语发音|English|Englisch)[^；。,\n]*(?:未完成|未记录|not_recorded|not completed)/i,
  ], levelA.english || levelA.englisch));
  setBoolean(entries, "德语语法", resolveNamedHabit(habitData, text, "德语语法", [/德语语法|Deutsch Grammatik|German grammar/i]));
  setBoolean(entries, "德语影子跟读", resolveNamedHabit(habitData, text, "德语影子跟读", [/德语影子跟读|影子跟读|shadowing|shadow reading/i]));
  setBoolean(entries, "武当1+2", resolveNamedHabit(habitData, text, "武当1+2", [/武当\s*1\s*\+?\s*2|武当|Wudang/i]));
  setBoolean(entries, "足弓", resolveNamedHabit(habitData, text, "足弓", [/足弓|foot arch/i]));
  setBoolean(entries, "健身", resolveNamedHabit(habitData, text, "健身", [/健身|力量训练|strength training|Krafttraining|gym/i]));
  setBoolean(entries, "基本功", resolveNamedHabit(habitData, text, "基本功", [/基本功|basic drill/i]));
  setBoolean(entries, "成品舞", resolveNamedHabit(habitData, text, "成品舞", [/成品舞|finished dance|choreo(?:graphy)?/i]));
  setBoolean(entries, "有氧操", resolveNamedHabit(habitData, text, "有氧操", [/有氧操|aerobics|cardio/i]));
  setBoolean(entries, "美容灯", resolveNamedHabit(habitData, text, "美容灯", [/美容灯|LED\s*light|beauty light/i]));

  for (const [name, patterns] of Object.entries({
    Praxisanleitung: [/Praxisanleitung[^\n]*(?:完成|completed|\d+\s*分钟|推进|学习)/i],
    Wundmanagement: [/Wundmanagement|伤口管理/i],
    Python: [/Python[^\n]*(?:完成|completed|\d+\s*分钟|推进|学习)/i],
    "Nursing Digest": [/Nursing Digest/i],
  })) {
    setBoolean(entries, name, resolveHabitStatus(habitData[name], text, patterns, [
      new RegExp(`${escapeRegex(name)}[^\\n]*(?:未完成|未记录|not_recorded|not completed)`, "i"),
    ]));
  }

  return entries;
}

function valueWithFallback(object, key, fallback) {
  return Object.prototype.hasOwnProperty.call(object || {}, key) ? object[key] : fallback;
}

function normalizeStructuredHabitData(data) {
  const result = {};
  if (data?.habits && typeof data.habits === "object" && !Array.isArray(data.habits)) {
    Object.assign(result, data.habits);
  }
  const tracker = data?.tracker && typeof data.tracker === "object" ? data.tracker : null;
  if (!tracker) {
    return result;
  }
  if (tracker.habits && typeof tracker.habits === "object" && !Array.isArray(tracker.habits)) {
    Object.assign(result, tracker.habits);
  }
  for (const name of normalizeHabitNameList(tracker.completed)) {
    result[name] = true;
  }
  for (const name of normalizeHabitNameList(tracker.not_completed || tracker.notCompleted)) {
    result[name] = null;
  }
  return result;
}

function normalizeHabitNameList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function extractTimelineData(text) {
  const match = String(text || "").match(/## 时间轴数据\s*```json\s*([\s\S]*?)```/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function resolveHabitStatus(raw, text, positivePatterns, negativePatterns) {
  const status = normalizeStatus(raw);
  if (status !== undefined) {
    return status;
  }
  if (negativePatterns.some((pattern) => pattern.test(text))) {
    return null;
  }
  if (positivePatterns.some((pattern) => pattern.test(text))) {
    return true;
  }
  return undefined;
}

function resolveNamedHabit(habitData, text, name, positivePatterns, negativePatterns = [], fallbackRaw = undefined) {
  const explicit = resolveHabitStatus(habitData[name], text, positivePatterns, negativePatterns);
  if (explicit !== undefined) {
    return explicit;
  }
  return resolveHabitStatus(fallbackRaw, text, positivePatterns, negativePatterns);
}

function normalizeStatus(value) {
  if (value === true) {
    return true;
  }
  if (value === false || value === null) {
    return null;
  }
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) {
    return undefined;
  }
  if (/not|未|unknown|none|missing/.test(text)) {
    return null;
  }
  if (/complete|done|完成|yes|recorded|min|分钟/.test(text)) {
    return true;
  }
  return undefined;
}

function setBoolean(entries, name, value) {
  if (value !== undefined) {
    entries[name] = value ? true : null;
  }
}

function normalizeDateText(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function localDateText(date, timeZone) {
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

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function* eachDate(startDate, endDate) {
  let current = startDate;
  while (current <= endDate) {
    yield current;
    current = addDaysText(current, 1);
  }
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  ObsidianTrackerSyncService,
  TRACKED_HABITS,
  extractTrackerEntries,
};
