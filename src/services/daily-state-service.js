const fs = require("fs");
const path = require("path");

const {
  DEFAULT_LEVEL_A,
  DEFAULT_LEVEL_B,
  DEFAULT_LEVEL_C,
  matchesHabit,
} = require("./critical-habits-monitor");
const { readMissingContextState } = require("./missing-context-service");

const NIGHT_SHIFT_PATTERN = /(night\s*shift|nachtdienst|nachtwache|夜班)/i;
const PHONE_PATTERN = /(screen\s*time|bildschirmzeit|刷手机|看手机|手机时间|手机使用|scroll)/i;
const COMMUTE_PATTERN = /(commute|通勤|出门|到家|回家|去上班|下班|路上|fahrt|weg)/i;
const SLEEP_PATTERN = /(sleep|睡觉|睡眠|补觉|躺床|休息|nap|schlaf)/i;
const LOW_ENERGY_PATTERN = /(累|困|疲惫|没力气|不在状态|耗竭|崩|脑子|低电量|状态不好|tired|exhausted)/i;
const PERIOD_PATTERN = /(大姨妈|月经|经期|肚子疼|痛经|止痛药|period)/i;
const WAKE_PATTERN = /(醒了|起床|睡醒|起来了|wake|woke)/i;
const CURRENT_WORK_PATTERN = /(我|现在|正在|还在).{0,8}(上班|工作|夜班|值班|dienst|shift)|(?:上班|夜班|值班).{0,8}(中|期间|现在)/i;

class DailyStateService {
  constructor({ config, dailyInbox, timeline, calendar, health } = {}) {
    this.config = config || {};
    this.dailyInbox = dailyInbox;
    this.timeline = timeline;
    this.calendar = calendar;
    this.health = health;
  }

  async analyze({ date = "", now = new Date() } = {}) {
    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const local = localDateParts(now, timeZone);
    const targetDate = normalizeText(date) || local.date;
    const inbox = this.readInbox(targetDate);
    const timelineEvents = await this.readTimelineEvents(targetDate);
    const calendarEvents = await this.readCalendarEvents(targetDate);
    const missingContext = readMissingContextState(this.config.missingContextStateFile, targetDate);
    const allText = [
      inbox.text,
      ...timelineEvents.map(eventToText),
      ...calendarEvents.map(calendarEventToText),
    ].join("\n");
    const levelA = analyzeHabits(DEFAULT_LEVEL_A, timelineEvents, allText);
    const levelB = analyzeHabits(DEFAULT_LEVEL_B, timelineEvents, allText);
    const levelC = analyzeHabits(DEFAULT_LEVEL_C, timelineEvents, allText);
    const nightShiftEvents = calendarEvents.filter(isNightShiftCalendarEvent);
    const phoneUseEvents = timelineEvents.filter((event) => PHONE_PATTERN.test(eventToText(event)));
    const commuteEvents = timelineEvents.filter((event) => COMMUTE_PATTERN.test(eventToText(event)));
    const sleepEvents = timelineEvents.filter((event) => SLEEP_PATTERN.test(eventToText(event)));
    const signals = {
      hasNightShift: nightShiftEvents.length > 0 || NIGHT_SHIFT_PATTERN.test(allText),
      hasPhoneUse: phoneUseEvents.length > 0 || PHONE_PATTERN.test(allText),
      hasCommute: commuteEvents.length > 0 || COMMUTE_PATTERN.test(allText),
      hasSleepOrRest: sleepEvents.length > 0 || SLEEP_PATTERN.test(allText),
      currentlyWorking: CURRENT_WORK_PATTERN.test(allText),
      lowEnergy: LOW_ENERGY_PATTERN.test(allText),
      periodOrBodyDiscomfort: PERIOD_PATTERN.test(allText),
      wakeMentioned: WAKE_PATTERN.test(allText),
      careerSignals: collectSignalMatches(allText, [
        "Praxisanleitung",
        "Wundmanagement",
        "Pflegewissenschaft",
        "ANP",
        "Research",
        "Forschung",
        "论文",
        "文献",
        "教学",
        "讲师",
      ]),
      bodyIdentitySignals: collectSignalMatches(allText, [
        "Sport",
        "运动",
        "Fitness",
        "健身",
        "Jazz",
        "爵士舞",
        "Dance",
        "跳舞",
        "力量训练",
      ]),
    };
    const recommendedMode = signals.lowEnergy || signals.periodOrBodyDiscomfort || signals.hasNightShift
      ? "minimum"
      : "standard";
    const priorityTiming = buildPriorityTiming({
      now,
      timeZone,
      targetDate,
      calendarEvents,
      signals,
      levelA,
      config: this.config,
    });

    return {
      date: targetDate,
      timeZone,
      generatedAt: now.toISOString(),
      sources: {
        dailyInbox: inbox.exists ? inbox.filePath : "",
        timelineEvents: timelineEvents.length,
        calendarEvents: calendarEvents.length,
        missingContextQuestions: missingContext.questions.length,
      },
      missingContext,
      signals,
      recommendedMode,
      priorityTiming,
      levelA,
      levelB,
      levelC,
    };
  }

  readInbox(date) {
    if (!this.dailyInbox || typeof this.dailyInbox.read !== "function") {
      return { exists: false, filePath: "", text: "" };
    }
    try {
      return this.dailyInbox.read({ date });
    } catch (error) {
      console.error(`[cyberboss] daily state inbox read failed date=${date}: ${error.message}`);
      return { exists: false, filePath: "", text: "" };
    }
  }

  async readTimelineEvents(date) {
    if (!this.timeline || typeof this.timeline.read !== "function") {
      return [];
    }
    try {
      const result = await this.timeline.read({ date });
      return Array.isArray(result?.data?.events) ? result.data.events : [];
    } catch (error) {
      console.error(`[cyberboss] daily state timeline read failed date=${date}: ${error.message}`);
      return [];
    }
  }

  async readCalendarEvents(date) {
    if (!this.calendar || typeof this.calendar.read !== "function") {
      return [];
    }
    const start = `${date}T00:00:00`;
    const end = addDaysText(date, 1) + "T00:00:00";
    try {
      const result = await this.calendar.read({ start, end, includeNotes: false });
      return Array.isArray(result?.events) ? result.events : [];
    } catch (error) {
      console.error(`[cyberboss] daily state calendar read failed date=${date}: ${error.message}`);
      return [];
    }
  }
}

function analyzeHabits(items, events, allText) {
  return items.map((item) => {
    const evidenceEvents = events.filter((event) => matchesHabit(event, item));
    const textMatched = item.keywords.some((keyword) => habitKeywordPattern(keyword).test(allText));
    return {
      id: item.id,
      label: item.label,
      meaning: item.meaning || "",
      estimatedMinutes: item.estimatedMinutes || 30,
      completed: evidenceEvents.length > 0 || textMatched,
      evidenceCount: evidenceEvents.length + (textMatched ? 1 : 0),
    };
  });
}

function buildPriorityTiming({ now, timeZone, targetDate, calendarEvents, signals, levelA, config }) {
  const local = localDateParts(now, timeZone);
  const missingLevelA = levelA.filter((item) => !item.completed);
  const nightShiftStart = findNightShiftStart(calendarEvents, targetDate, timeZone);
  const fixedHour = Number.isInteger(config.criticalHabitsLevelAHour)
    ? config.criticalHabitsLevelAHour
    : 20;
  let reason = "";
  let dueAtMinutes = fixedHour * 60;
  let boundaryLabel = "";

  if (nightShiftStart !== null) {
    const minutesBeforeShift = Number.isInteger(config.criticalHabitsNightShiftLeadMinutes)
      ? config.criticalHabitsNightShiftLeadMinutes
      : 180;
    dueAtMinutes = Math.min(dueAtMinutes, Math.max(0, nightShiftStart - minutesBeforeShift));
    reason = "night_shift_boundary";
    boundaryLabel = "夜班前";
  }

  if (signals.hasNightShift && signals.hasSleepOrRest) {
    const recoveryHour = Number.isInteger(config.criticalHabitsRecoveryHour)
      ? config.criticalHabitsRecoveryHour
      : 15;
    dueAtMinutes = Math.min(dueAtMinutes, recoveryHour * 60);
    reason = reason || "night_shift_recovery";
    boundaryLabel = boundaryLabel || "夜班后恢复日";
  }

  const localMinutes = local.hour * 60 + local.minute;
  return {
    localDate: local.date,
    isToday: local.date === targetDate,
    missingLevelA: missingLevelA.map((item) => item.id),
    dueAtMinutes,
    dueAt: `${String(Math.floor(dueAtMinutes / 60)).padStart(2, "0")}:${String(dueAtMinutes % 60).padStart(2, "0")}`,
    isDue: local.date === targetDate && missingLevelA.length > 0 && localMinutes >= dueAtMinutes,
    reason: reason || "fixed_daily_guardian_time",
    boundaryLabel,
    recommendedLeadMinutes: nightShiftStart !== null ? Math.max(0, nightShiftStart - localMinutes) : null,
  };
}

function findNightShiftStart(events, date, timeZone) {
  const candidates = events
    .filter(isNightShiftCalendarEvent)
    .map((event) => {
      const start = parseDate(event.start);
      if (!start) return null;
      const local = localDateParts(start, timeZone);
      if (local.date !== date) return null;
      const minutes = local.hour * 60 + local.minute;
      return minutes >= 12 * 60 ? minutes : null;
    })
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  return candidates.length ? candidates[0] : null;
}

function isNightShiftCalendarEvent(event) {
  return NIGHT_SHIFT_PATTERN.test(calendarEventToText(event));
}

function eventToText(event) {
  const tags = Array.isArray(event?.tags) ? event.tags.join(" ") : "";
  return [
    event?.title,
    event?.note,
    event?.description,
    event?.categoryId,
    event?.subcategoryId,
    event?.eventNodeId,
    tags,
  ].filter(Boolean).join(" ");
}

function calendarEventToText(event) {
  return [
    event?.title,
    event?.calendar,
    event?.location,
    event?.notes,
  ].filter(Boolean).join(" ");
}

function collectSignalMatches(text, labels) {
  const lower = String(text || "").toLowerCase();
  return labels.filter((label) => lower.includes(label.toLowerCase()));
}

function habitKeywordPattern(keyword) {
  const escaped = String(keyword || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/[\u3400-\u9fff]/u.test(keyword)) {
    return new RegExp(escaped, "iu");
  }
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu");
}

function localDateParts(date, timeZone) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function defaultObsidianDailyNotePath(config, date) {
  const vaultDir = normalizeText(config.obsidianVaultDir)
    || path.join(process.env.HOME || "", "Library/Mobile Documents/iCloud~md~obsidian/Documents/Jiao's Obsidian");
  const dailyFolder = normalizeText(config.obsidianDailyFolder) || "03. 🔵 Tagebuch/01. 日记";
  return path.join(vaultDir, dailyFolder, `${date}.md`);
}

function dailyReviewExists(config, date) {
  const notePath = defaultObsidianDailyNotePath(config, date);
  if (!fs.existsSync(notePath)) {
    return { ok: false, notePath, reason: "missing_note" };
  }
  const text = fs.readFileSync(notePath, "utf8");
  const hasReview = /##\s*每日复盘/.test(text);
  const hasPendingMarker = /待午夜后自动生成|结构化 timeline-for-agent 在 .* 没有可用事件/.test(text);
  return {
    ok: hasReview && !hasPendingMarker,
    notePath,
    reason: hasReview ? (hasPendingMarker ? "pending_marker" : "") : "missing_review",
  };
}

module.exports = {
  DailyStateService,
  buildPriorityTiming,
  dailyReviewExists,
  defaultObsidianDailyNotePath,
};
