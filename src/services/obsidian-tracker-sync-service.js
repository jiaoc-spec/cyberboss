const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_DAILY_FOLDER = "03. 🔵 Tagebuch/01. 日记";

const TRACKED_HABITS = [
  { name: "Sport", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "冥想", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "英语发音", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "英语影子跟读", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "德语语法", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "德语影子跟读", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "骨盆", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "足弓", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "健身", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "基本功", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "成品舞", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "有氧操", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "美容灯", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "看书", type: "boolean", frequency: "day", completionGoal: 1, statsType: "heatmap" },
  { name: "Praxisanleitung", type: "boolean", frequency: "week", completionGoal: 2, statsType: "heatmap" },
  { name: "Wundmanagement", type: "boolean", frequency: "week", completionGoal: 1, statsType: "heatmap" },
  { name: "Python", type: "boolean", frequency: "week", completionGoal: 2, statsType: "heatmap" },
  { name: "Nursing Digest", type: "boolean", frequency: "week", completionGoal: 1, statsType: "heatmap" },
];

const TRACKED_NAME_SET = new Set(TRACKED_HABITS.map((habit) => habit.name));

const LEVEL_A_KEY_TO_HABIT = {
  sport: "Sport",
  english: "英语发音",
  englisch: "英语发音",
  english_pronunciation: "英语发音",
  english_shadowing: "英语影子跟读",
  english_shadow_reading: "英语影子跟读",
  german_grammar: "德语语法",
  german_shadowing: "德语影子跟读",
  meditation: "冥想",
};

// A line that asserts a habit was NOT done. The prose fallback must never read
// a habit name out of such a line as a completion (the over-check bug: names
// inside "missing / 未完成 / 没有形成完成记录" lists were marked done).
const NEGATION_LINE_PATTERN = /(没有|没|未|无\s|missing|not[\s_]|跳过|缺席|未完成|未记录|不计为|no\s+record)/i;

// Legacy habit names that have been renamed. Old daily notes still say the old
// name; map it to the current tracked name so historical completions stay on
// the same heatmap row instead of vanishing. 武当1+2 was renamed to 骨盆.
const HABIT_ALIASES = {
  "武当1+2": "骨盆",
  "武当": "骨盆",
};

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

function extractTrackerEntries(fullText) {
  const entries = {};
  // Daily-review notes use inconsistent JSON shapes across days and sometimes
  // carry MULTIPLE json blocks, so scan all of them and merge the structured
  // habit status. This is the trustworthy source; prose is only a fallback.
  const blocks = extractAllTimelineData(fullText);
  const habitData = collectStructuredHabitStatus(blocks);
  const levelACarrier = blocks.find((block) => block && (block.level_a || block.levelA));
  const levelA = (levelACarrier && (levelACarrier.level_a || levelACarrier.levelA)) || {};
  // Run all prose pattern matching against the human text ONLY, with the
  // structured JSON block removed - otherwise habit names sitting inside the
  // block's "missing"/"not_completed" arrays get matched as completions.
  const text = stripTimelineDataBlock(fullText);
  setBoolean(entries, "Sport", resolveHabitStatus(valueWithFallback(habitData, "Sport", levelA.sport), text, [
    /(?:运动|Sport|健身|力量训练|有氧操|跑步|锻炼)[^\n]*(?:已完成|完成|completed|done|\d+\s*分钟)/i,
  ], [
    /(?:运动|Sport)[：:][^\n]*(?:未完成|未记录|not_recorded|not completed)/i,
  ]));
  setBoolean(entries, "冥想", resolveNamedHabit(habitData, text, "冥想", [/冥想|meditation/i]));
  setBoolean(entries, "英语发音", resolveNamedHabit(habitData, text, "英语发音", [/英语发音|English pronunciation|Englisch|Rachel'?s English|Rachel’s English/i], [
    /(?:英语发音|English|Englisch)[^；。,\n]*(?:未完成|未记录|not_recorded|not completed)/i,
  ], levelA.english || levelA.englisch));
  setBoolean(entries, "英语影子跟读", resolveNamedHabit(habitData, text, "英语影子跟读", [
    /英语影子跟读|英语跟读|English shadowing|English shadow reading|shadowing English/i,
  ], [
    /(?:英语影子跟读|英语跟读|English shadowing|English shadow reading)[^；。,\n]*(?:未完成|未记录|not_recorded|not completed)/i,
  ], levelA.english_shadowing || levelA.englishShadowing));
  setBoolean(entries, "德语语法", resolveNamedHabit(habitData, text, "德语语法", [/德语语法|Deutsch Grammatik|German grammar/i]));
  setBoolean(entries, "德语影子跟读", resolveNamedHabit(habitData, text, "德语影子跟读", [/德语影子跟读|德语跟读|Deutsch shadowing|German shadowing|Deutsch shadow reading|German shadow reading/i]));
  setBoolean(entries, "骨盆", resolveNamedHabit(habitData, text, "骨盆", [/骨盆|盆底|pelvic(?:\s*floor)?|武当\s*1\s*\+?\s*2|武当|Wudang/i]));
  setBoolean(entries, "足弓", resolveNamedHabit(habitData, text, "足弓", [/足弓|foot arch/i]));
  setBoolean(entries, "健身", resolveNamedHabit(habitData, text, "健身", [/健身|力量训练|strength training|Krafttraining|gym/i]));
  setBoolean(entries, "基本功", resolveNamedHabit(habitData, text, "基本功", [/基本功|basic drill/i]));
  setBoolean(entries, "成品舞", resolveNamedHabit(habitData, text, "成品舞", [/成品舞|finished dance|choreo(?:graphy)?/i]));
  setBoolean(entries, "有氧操", resolveNamedHabit(habitData, text, "有氧操", [/有氧操|aerobics|cardio/i]));
  setBoolean(entries, "美容灯", resolveNamedHabit(habitData, text, "美容灯", [/美容灯|LED\s*light|beauty light/i]));
  setBoolean(entries, "看书", resolveNamedHabit(habitData, text, "看书", [
    /看书|读书|看了书|读了书|在看书|在读书|阅读了?《|读了《|看了《|在读《|读了.{0,40}第.{1,4}章|阅读了?.{0,40}第.{1,4}章|看完.{0,8}(?:书|一本|一章)|读完.{0,8}(?:书|一本|一章)|读了一本|gelesen|reading\s+(?:a\s+)?book/i,
  ]));

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

// Merge structured habit status across ALL json blocks in a note, tolerant of
// the inconsistent schemas daily reviews have used: tracker.completed /
// tracker.not_completed, habits_completed, habit_status / habits maps, and
// levelA|level_a with either a nested completed/missing array or a
// key->status map (sport: "not_recorded"). Returns tracked-habit name -> true/null.
function collectStructuredHabitStatus(blocks) {
  const status = {};
  const setTrue = (rawName) => {
    const name = canonicalHabit(rawName);
    if (name) {
      status[name] = true;
    }
  };
  const setNotDone = (rawName) => {
    const name = canonicalHabit(rawName);
    if (name && status[name] !== true) {
      status[name] = null;
    }
  };
  const applyMap = (map) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      return;
    }
    for (const [key, value] of Object.entries(map)) {
      const s = normalizeStatus(value);
      if (s === true) {
        setTrue(key);
      } else if (s === null) {
        setNotDone(key);
      }
    }
  };

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== "object") {
      continue;
    }
    for (const name of normalizeHabitNameList(block.habits_completed)) {
      setTrue(name);
    }
    const tracker = block.tracker && typeof block.tracker === "object" ? block.tracker : {};
    for (const name of normalizeHabitNameList(tracker.completed)) {
      setTrue(name);
    }
    for (const name of normalizeHabitNameList(tracker.not_completed || tracker.notCompleted)) {
      setNotDone(name);
    }
    applyMap(block.habits);
    applyMap(block.habit_status);
    applyMap(tracker.habits);
    applyMap(tracker.habit_status);
    for (const levelA of [block.levelA, block.level_a]) {
      if (!levelA || typeof levelA !== "object") {
        continue;
      }
      for (const name of normalizeHabitNameList(levelA.completed)) {
        setTrue(name);
      }
      for (const name of normalizeHabitNameList(levelA.missing)) {
        setNotDone(name);
      }
      for (const [key, value] of Object.entries(levelA)) {
        if (Array.isArray(value)) {
          continue;
        }
        const name = LEVEL_A_KEY_TO_HABIT[String(key).toLowerCase()];
        if (!name) {
          continue;
        }
        const s = normalizeStatus(value);
        if (s === true) {
          setTrue(name);
        } else if (s === null) {
          setNotDone(name);
        }
      }
    }
  }
  return status;
}

// Map a structured habit name to its canonical tracked name (or "" to ignore).
function canonicalHabit(rawName) {
  const name = String(rawName || "").trim();
  if (TRACKED_NAME_SET.has(name)) {
    return name;
  }
  if (HABIT_ALIASES[name] && TRACKED_NAME_SET.has(HABIT_ALIASES[name])) {
    return HABIT_ALIASES[name];
  }
  const mapped = LEVEL_A_KEY_TO_HABIT[name.toLowerCase()];
  return mapped && TRACKED_NAME_SET.has(mapped) ? mapped : "";
}

function normalizeHabitNameList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function extractTimelineData(text) {
  return extractAllTimelineData(text)[0] || null;
}

function extractAllTimelineData(text) {
  const blocks = [];
  const re = /```json\s*([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(String(text || "")))) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object") {
        blocks.push(parsed);
      }
    } catch {
      // ignore non-JSON or malformed fenced blocks
    }
  }
  return blocks;
}

function resolveHabitStatus(raw, text, positivePatterns, negativePatterns) {
  const status = normalizeStatus(raw);
  if (status !== undefined) {
    return status;
  }
  if (negativePatterns.some((pattern) => pattern.test(text))) {
    return null;
  }
  if (matchesPositiveLine(text, positivePatterns)) {
    return true;
  }
  return undefined;
}

// A positive pattern only counts when it matches a prose line that is NOT a
// negation line. This stops a habit name appearing in a "没做/未完成/missing"
// sentence from being recorded as a completion.
function matchesPositiveLine(text, positivePatterns) {
  if (!positivePatterns.length) {
    return false;
  }
  const lines = String(text || "").split("\n");
  for (const line of lines) {
    if (!line.trim() || NEGATION_LINE_PATTERN.test(line)) {
      continue;
    }
    if (positivePatterns.some((pattern) => pattern.test(line))) {
      return true;
    }
  }
  return false;
}

function stripTimelineDataBlock(text) {
  return String(text || "").replace(/## 时间轴数据\s*```json[\s\S]*?```/g, "");
}

// The set of tracked habits a day's structured block explicitly confirms as
// completed. Used to repair days whose checkmarks were over-set, and as the
// trustworthy completion source. Never infers from prose.
function structuredCompletedHabits(text) {
  const status = collectStructuredHabitStatus(extractAllTimelineData(text));
  return Object.keys(status).filter((name) => status[name] === true);
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
  if (/未|无记录|unknown|none|missing|no[_\s]?record|not[_\s]?record|not_recorded|not_completed|\bnot\b|skip|跳过/.test(text)) {
    return null;
  }
  if (/complete|done|完成|搞定|yes|recorded|分钟|\bmin\b|\d\s*min/.test(text)) {
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
  TRACKED_NAME_SET,
  extractTrackerEntries,
  structuredCompletedHabits,
  stripTimelineDataBlock,
};
