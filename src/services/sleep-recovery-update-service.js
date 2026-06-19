const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { getCanonicalDayType } = require("./day-operations-planner-service");

const RUN_KEY_PREFIX = "sleep-recovery:";
const BLOCK_PREFIX = "<!-- cyberboss-sleep-recovery:";
const BLOCK_END_PREFIX = "<!-- /cyberboss-sleep-recovery:";

class SleepRecoveryUpdateService {
  constructor({ config, calendar, obsidianNote, dayOperationsPlanner = null } = {}) {
    this.config = config || {};
    this.calendar = calendar;
    this.obsidianNote = obsidianNote;
    this.dayOperationsPlanner = dayOperationsPlanner;
    this.stateFile = this.config.sleepRecoveryUpdateStateFile;
    this.lastCheckAtMs = 0;
  }

  async check(now = new Date()) {
    if (this.config.sleepRecoveryUpdateEnabled === false || !this.calendar || !this.obsidianNote) {
      return { action: "disabled" };
    }
    const intervalMs = this.config.sleepRecoveryUpdateCheckIntervalMs || 1_800_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { action: "throttled" };
    }
    this.lastCheckAtMs = now.getTime();

    const timeZone = this.resolveTimeZone();
    const local = localDateParts(now, timeZone);
    const startMinutes = (this.config.sleepRecoveryUpdateHour ?? 9) * 60
      + (this.config.sleepRecoveryUpdateMinute ?? 30);
    if (local.hour * 60 + local.minute < startMinutes) {
      return { action: "before_window" };
    }

    const targetDates = resolveTargetDates(local.date, this.config.sleepRecoveryUpdateLookbackDays || 2);
    const updates = [];
    const state = this.loadState();
    for (const targetDate of targetDates) {
      const result = await this.updateTargetDate({ targetDate, timeZone, state, now });
      if (result.action === "updated") {
        updates.push(result);
      }
    }
    if (updates.length) {
      this.saveState(state);
      return { action: "updated", updates };
    }
    this.saveState(state);
    return { action: "no_update", targetDates };
  }

  async updateTargetDate({ targetDate, timeZone, state, now }) {
    const window = buildTargetWindow(targetDate, timeZone);
    const readResult = await this.calendar.read({
      start: window.start,
      end: window.end,
      includeNotes: true,
      includeUrls: false,
      requestAccess: false,
    });
    const events = Array.isArray(readResult?.events) ? readResult.events : [];
    const sleepEvents = events
      .filter((event) => isSleepEvent(event))
      .map((event) => normalizeCalendarEvent(event))
      .filter((event) => isValidTimedEvent(event))
      .filter((event) => event.durationMinutes >= 20);
    if (!sleepEvents.length) {
      return { action: "no_sleep", targetDate };
    }

    const shiftEvents = events
      .filter((event) => isShiftEvent(event))
      .map((event) => normalizeCalendarEvent(event))
      .filter((event) => isValidTimedEvent(event));
    const operationsPlan = await this.readDayOperationsPlan({
      targetDate,
      timeZone,
    });
    const summary = buildSleepRecoverySummary({
      targetDate,
      timeZone,
      sleepEvents,
      shiftEvents,
      operationsPlan,
    });
    if (!summary.sections.length) {
      return { action: "no_relevant_sleep", targetDate };
    }

    const hash = hashSummary(summary);
    const key = `${RUN_KEY_PREFIX}${targetDate}`;
    const previous = state.runs[key];
    if (previous?.hash === hash) {
      return { action: "unchanged", targetDate };
    }

    const relativePath = `${this.config.obsidianDailyFolder || "03. 🔵 Tagebuch/01. 日记"}/${targetDate}.md`;
    const content = renderSleepRecoveryUpdate(summary, { hash });
    const write = writeOrReplaceRecoveryBlock({
      obsidianNote: this.obsidianNote,
      relativePath,
      targetDate,
      content,
    });
    state.runs[key] = {
      status: "updated",
      hash,
      updatedAt: now.toISOString(),
      sleepCount: sleepEvents.length,
      shiftMode: summary.shiftMode,
    };
    console.log(`[cyberboss] sleep recovery updated date=${targetDate} sleep=${sleepEvents.length} shift=${summary.shiftMode}`);
    return { action: "updated", targetDate, filePath: write.filePath, hash, shiftMode: summary.shiftMode };
  }

  resolveTimeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }

  async readDayOperationsPlan({ targetDate, timeZone }) {
    if (!this.dayOperationsPlanner || typeof this.dayOperationsPlanner.plan !== "function") {
      return null;
    }
    try {
      const noon = localDateTimeToDate(`${targetDate}T12:00:00`, timeZone);
      return await this.dayOperationsPlanner.plan({ date: targetDate, now: noon });
    } catch (error) {
      console.error(`[cyberboss] sleep recovery day operations plan failed date=${targetDate}: ${error.message}`);
      return null;
    }
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return { runs: parsed?.runs && typeof parsed.runs === "object" ? parsed.runs : {} };
    } catch {
      return { runs: {} };
    }
  }

  saveState(state) {
    if (!this.stateFile) {
      return;
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function buildSleepRecoverySummary({ targetDate, timeZone, sleepEvents, shiftEvents, operationsPlan = null }) {
  const nextDate = addDaysText(targetDate, 1);
  const targetStart = localDateTimeToDate(`${targetDate}T00:00:00`, timeZone);
  const targetNoon = localDateTimeToDate(`${targetDate}T12:00:00`, timeZone);
  const targetEvening = localDateTimeToDate(`${targetDate}T18:00:00`, timeZone);
  const nextNoon = localDateTimeToDate(`${nextDate}T12:00:00`, timeZone);
  const nextEvening = localDateTimeToDate(`${nextDate}T18:00:00`, timeZone);
  const canonicalDayType = getCanonicalDayType(operationsPlan);
  const calendarNightShift = shiftEvents.find((event) => event.shiftKind === "night" && overlaps(event, {
    start: targetEvening,
    end: nextNoon,
  }));
  const plannerNightShift = buildPlannerNightShift({
    targetDate,
    timeZone,
    operationsPlan,
  });
  const nightShift = canonicalDayType
    ? (canonicalDayType === "night_shift" ? (calendarNightShift || plannerNightShift) : null)
    : calendarNightShift;
  const shiftMode = canonicalDayType && canonicalDayType !== "normal_day"
    ? canonicalDayType
    : (calendarNightShift ? "night_shift" : resolveDayShiftMode(shiftEvents, targetDate, timeZone));

  const beforeDaySleep = sleepEvents.filter((event) => event.end > targetStart && event.end <= targetNoon);
  const endOfDaySleep = sleepEvents.filter((event) => event.start >= targetEvening && event.start < nextNoon);
  const nightShiftPreSleep = nightShift
    ? sleepEvents.filter((event) => event.end <= nightShift.start && event.end > targetStart)
    : [];
  const nightShiftPostSleep = nightShift
    ? sleepEvents.filter((event) => event.start >= nightShift.end && event.start < nextEvening)
    : [];

  const sections = [];
  if (nightShift) {
    if (nightShiftPreSleep.length) {
      sections.push({
        label: "夜班前补觉",
        events: nightShiftPreSleep,
        meaning: "用于判断夜班前是否有预先恢复。",
      });
    }
    if (nightShiftPostSleep.length) {
      sections.push({
        label: "夜班后恢复睡眠",
        events: nightShiftPostSleep,
        meaning: "用于判断夜班后的恢复质量和当天是否适合 minimum mode。",
      });
    }
    if (!nightShiftPreSleep.length && !nightShiftPostSleep.length) {
      sections.push({
        label: "夜班相关睡眠",
        events: [],
        meaning: "已识别夜班，但日历里还没有匹配到夜班前或夜班后的睡眠记录。",
      });
    }
  } else {
    if (beforeDaySleep.length) {
      sections.push({
        label: "进入这一天之前的睡眠",
        events: beforeDaySleep,
        meaning: "主要用于解释当天白天的能量基础。",
      });
    }
    if (endOfDaySleep.length) {
      sections.push({
        label: "这一天结束后的恢复睡眠",
        events: endOfDaySleep,
        meaning: "这段数据通常第二天早上才出现，用于补全前一天的恢复结果。",
      });
    }
  }

  return {
    targetDate,
    timeZone,
    shiftMode,
    canonicalDayType: canonicalDayType || "",
    nightShift,
    sections,
    sleepEvents,
  };
}

function renderSleepRecoveryUpdate(summary, { hash }) {
  const lines = [
    "## 睡眠 / 恢复补全",
    "",
    `${BLOCK_PREFIX}${summary.targetDate}:${hash} -->`,
    "",
  ];
  lines.push(`- 日期：${summary.targetDate}`);
  lines.push(`- 班次语境：${formatShiftMode(summary.shiftMode)}`);
  for (const section of summary.sections) {
    if (section.events.length) {
      lines.push(`- ${section.label}：${formatEventList(section.events, summary.timeZone)}。${section.meaning}`);
    } else {
      lines.push(`- ${section.label}：未在睡眠日历中找到对应记录。${section.meaning}`);
    }
  }
  lines.push(`- 复盘使用方式：睡眠按真实时间进入 Timeline；这里按它对恢复和次日状态的解释力补充到日记。`);
  lines.push("");
  lines.push(`${BLOCK_END_PREFIX}${summary.targetDate} -->`);
  return lines.join("\n");
}

function writeOrReplaceRecoveryBlock({ obsidianNote, relativePath, targetDate, content }) {
  const filePath = obsidianNote.resolveSafePath(relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : `# ${targetDate} 日记\n`;
  const markerPattern = new RegExp(
    `${escapeRegExp(BLOCK_PREFIX)}${escapeRegExp(targetDate)}:[^\\n]*-->[\\s\\S]*?${escapeRegExp(BLOCK_END_PREFIX)}${escapeRegExp(targetDate)}\\s*-->`,
    "m",
  );
  const sectionPattern = new RegExp(
    `^## 睡眠 \\/ 恢复补全\\s*\\n\\s*${markerPattern.source}`,
    "m",
  );
  let next;
  if (sectionPattern.test(existing)) {
    next = existing.replace(sectionPattern, content);
  } else if (markerPattern.test(existing)) {
    next = existing.replace(markerPattern, content);
  } else if (/^## 睡眠 \/ 恢复补全\s*$/m.test(existing)) {
    next = existing.replace(/^## 睡眠 \/ 恢复补全\s*$/m, content);
  } else {
    next = `${existing.replace(/\n*$/, "")}\n\n${content}\n`;
  }
  fs.writeFileSync(filePath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  return { filePath };
}

function isValidTimedEvent(event) {
  return event.start instanceof Date
    && event.end instanceof Date
    && !Number.isNaN(event.start.getTime())
    && !Number.isNaN(event.end.getTime())
    && event.end > event.start;
}

function isSleepEvent(event) {
  const text = eventText(event);
  return /(睡眠|睡觉|补觉|午睡|小睡|睡着|sleep|asleep|nap|schlaf|schlafen|bett|in bed|bedtime|core sleep|deep sleep|rem sleep)/i.test(text);
}

function isShiftEvent(event) {
  const text = eventText(event);
  return /(nachtdienst|frühdienst|fruehdienst|spätdienst|spaetdienst|night\s*shift|early\s*shift|late\s*shift|夜班|早班|晚班|dienst|shift|arbeit)/i.test(text);
}

function normalizeCalendarEvent(event) {
  const start = parseDate(event?.start);
  const end = parseDate(event?.end);
  const text = eventText(event);
  const shiftKind = /(nachtdienst|night\s*shift|夜班)/i.test(text)
    ? "night"
    : /(frühdienst|fruehdienst|early\s*shift|早班)/i.test(text)
      ? "early"
      : /(spätdienst|spaetdienst|late\s*shift|晚班)/i.test(text)
        ? "late"
        : "";
  return {
    title: normalizeText(event?.title),
    calendar: normalizeText(event?.calendar),
    start,
    end,
    durationMinutes: Math.round(((end.getTime() - start.getTime()) / 60_000) * 10) / 10,
    shiftKind,
  };
}

function resolveDayShiftMode(shiftEvents, targetDate, timeZone) {
  const onDate = shiftEvents.filter((event) => formatDate(event.start, timeZone) === targetDate);
  if (onDate.some((event) => event.shiftKind === "early")) {
    return "early_shift";
  }
  if (onDate.some((event) => event.shiftKind === "late")) {
    return "late_shift";
  }
  if (onDate.length) {
    return "work_day";
  }
  return "off_or_unknown";
}

function buildPlannerNightShift({ targetDate, timeZone, operationsPlan = null }) {
  if (getCanonicalDayType(operationsPlan) !== "night_shift") {
    return null;
  }
  const fixedBlocks = Array.isArray(operationsPlan?.fixedBlocks) ? operationsPlan.fixedBlocks : [];
  const recoveryWindows = Array.isArray(operationsPlan?.recoveryWindows) ? operationsPlan.recoveryWindows : [];
  const nightBlock = fixedBlocks.find((block) => {
    const text = `${normalizeText(block?.kind)} ${normalizeText(block?.label)} ${normalizeText(block?.title)}`;
    return /(night_shift|nachtdienst|night\s*shift|夜班)/i.test(text);
  }) || null;
  const recoveryStart = recoveryWindows.find((window) => {
    const text = `${normalizeText(window?.reason)} ${normalizeText(window?.label)}`;
    return /(night|nacht|夜班)/i.test(text);
  }) || recoveryWindows[0] || null;
  const startMinutes = readPlanMinute(nightBlock?.startMinutes, nightBlock?.start, 21 * 60 + 30);
  const endMinutes = readPlanMinute(recoveryStart?.startMinutes, recoveryStart?.start, 7 * 60);
  const startDate = targetDate;
  const endDate = endMinutes <= startMinutes ? addDaysText(targetDate, 1) : targetDate;
  const start = localDateTimeToDate(`${startDate}T${minutesToClock(startMinutes)}:00`, timeZone);
  const end = localDateTimeToDate(`${endDate}T${minutesToClock(endMinutes)}:00`, timeZone);
  if (!(end > start)) {
    return null;
  }
  return {
    title: normalizeText(nightBlock?.label) || "Day Operations Plan Nachtdienst",
    calendar: "Day Operations Plan",
    start,
    end,
    durationMinutes: Math.round(((end.getTime() - start.getTime()) / 60_000) * 10) / 10,
    shiftKind: "night",
  };
}

function readPlanMinute(value, clockText, fallback) {
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0 && number < 24 * 60) {
    return number;
  }
  const match = normalizeText(clockText).match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return hour * 60 + minute;
    }
  }
  return fallback;
}

function minutesToClock(minutes) {
  const bounded = Math.max(0, Math.min(23 * 60 + 59, Number(minutes) || 0));
  const hour = Math.floor(bounded / 60);
  const minute = bounded % 60;
  return `${pad(hour)}:${pad(minute)}`;
}

function formatShiftMode(value) {
  if (value === "night_shift") {
    return "夜班 / Nachtdienst";
  }
  if (value === "early_shift") {
    return "早班 / Frühdienst";
  }
  if (value === "late_shift") {
    return "晚班 / Spätdienst";
  }
  if (value === "course_day") {
    return "Weiterbildung / 课程日";
  }
  if (value === "off_day") {
    return "休息日 / Frei";
  }
  if (value === "work_day") {
    return "工作日";
  }
  return "休息日或未识别班次";
}

function formatEventList(events, timeZone) {
  const totalMinutes = events.reduce((sum, event) => sum + event.durationMinutes, 0);
  const ranges = events.map((event) => `${formatTime(event.start, timeZone)}-${formatTime(event.end, timeZone)}`);
  return `${ranges.join("，")}，合计 ${formatDuration(totalMinutes)}`;
}

function hashSummary(summary) {
  const body = JSON.stringify({
    targetDate: summary.targetDate,
    shiftMode: summary.shiftMode,
    sections: summary.sections.map((section) => ({
      label: section.label,
      events: section.events.map((event) => ({
        start: event.start.toISOString(),
        end: event.end.toISOString(),
        title: event.title,
      })),
    })),
  });
  return crypto.createHash("sha1").update(body).digest("hex").slice(0, 12);
}

function buildTargetWindow(targetDate, timeZone) {
  const previousDate = addDaysText(targetDate, -1);
  const nextDate = addDaysText(targetDate, 1);
  return {
    start: formatDateTimeWithOffset(localDateTimeToDate(`${previousDate}T18:00:00`, timeZone), timeZone),
    end: formatDateTimeWithOffset(localDateTimeToDate(`${nextDate}T20:00:00`, timeZone), timeZone),
  };
}

function resolveTargetDates(localDate, lookbackDays) {
  const days = Math.max(1, Number(lookbackDays) || 2);
  const result = [];
  for (let offset = 1; offset <= days; offset += 1) {
    result.push(addDaysText(localDate, -offset));
  }
  return result;
}

function overlaps(event, range) {
  return event.start < range.end && event.end > range.start;
}

function eventText(event) {
  return [
    normalizeText(event?.title),
    normalizeText(event?.calendar),
    normalizeText(event?.notes),
  ].join("\n");
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : new Date(NaN);
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

function localDateTimeToDate(value, timeZone) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid local date time: ${value}`);
  }
  const desiredUtcMs = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  let candidateMs = desiredUtcMs;
  for (let index = 0; index < 2; index += 1) {
    const parts = dateParts(new Date(candidateMs), timeZone);
    const representedUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidateMs += desiredUtcMs - representedUtcMs;
  }
  return new Date(candidateMs);
}

function formatDateTimeWithOffset(date, timeZone) {
  const parts = dateParts(date, timeZone);
  const offset = getOffsetMinutes(date, timeZone);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function formatDate(date, timeZone) {
  const parts = dateParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function formatTime(date, timeZone) {
  const parts = dateParts(date, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

function dateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }
  return values;
}

function getOffsetMinutes(date, timeZone) {
  const parts = dateParts(date, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return Math.round((localAsUtc - date.getTime()) / 60_000);
}

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDuration(minutes) {
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours && mins) {
    return `${hours}小时${mins}分钟`;
  }
  if (hours) {
    return `${hours}小时`;
  }
  return `${mins}分钟`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  SleepRecoveryUpdateService,
  buildSleepRecoverySummary,
  isSleepEvent,
  renderSleepRecoveryUpdate,
  resolveTargetDates,
};
