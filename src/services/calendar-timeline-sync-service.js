const crypto = require("crypto");
const fs = require("fs");

const { resolveToday3x3DatabasePath } = require("./today3x3-timeline-sync-service");

const MIN_EVENT_MINUTES = 3;

class CalendarTimelineSyncService {
  constructor({ config, calendar, timeline }) {
    this.config = config || {};
    this.calendar = calendar;
    this.timeline = timeline;
  }

  async sync({ start = "", end = "", days = 0, calendars = undefined } = {}) {
    if (!this.calendar || !this.timeline) {
      return { imported: [], skipped: 0 };
    }
    const timeZone = normalizeText(this.config.timeZone) || normalizeText(this.config.diaryTimeZone) || "UTC";
    const readResult = await this.calendar.read({
      start,
      end,
      days: days || this.config.calendarTimelineSyncDays || 2,
      calendars: Array.isArray(calendars) ? calendars : this.config.calendarTimelineSyncCalendars,
      includeNotes: true,
      includeUrls: false,
      requestAccess: false,
    });
    const events = [];
    let skipped = 0;
    const today3x3Available = this.config.today3x3TimelineSync !== false
      && fs.existsSync(resolveToday3x3DatabasePath(this.config));
    for (const item of Array.isArray(readResult?.events) ? readResult.events : []) {
      if (today3x3Available && isCalendarPhoneEvent(item)) {
        skipped += 1;
        continue;
      }
      const itemEvents = calendarEventToTimelineEvents(item, timeZone);
      if (itemEvents.length) {
        events.push(...itemEvents);
      } else {
        skipped += 1;
      }
    }
    const byDate = groupBy(events, (event) => formatDate(parseDateOrNow(event.startAt), timeZone));
    const imported = [];
    for (const [date, dateEvents] of byDate.entries()) {
      await this.timeline.write({
        date,
        events: dateEvents,
        mode: "merge",
      });
      imported.push(...dateEvents);
    }
    return {
      provider: readResult?.provider || "apple-calendar",
      authorization: readResult?.authorization || "",
      imported,
      skipped,
    };
  }
}

function isCalendarPhoneEvent(item) {
  return classifyCalendarEvent([
    normalizeText(item?.title),
    normalizeText(item?.calendar),
    normalizeText(item?.notes),
  ].join("\n")).tags.includes("phone");
}

function calendarEventToTimelineEvents(item, timeZone) {
  if (!item || item.isAllDay) {
    return [];
  }
  const title = normalizeText(item.title);
  const calendarName = normalizeText(item.calendar);
  const startDate = parseDateOrNow(item.start);
  const endDate = parseDateOrNow(item.end);
  if (!title || !isUsableRange(startDate, endDate)) {
    return [];
  }
  const classification = classifyCalendarEvent(`${title}\n${calendarName}\n${normalizeText(item.notes)}`);
  const ranges = splitRangeByLocalDate(startDate, endDate, timeZone);
  return ranges.map(({ start, end }, index) => {
    const startAt = formatDateTimeWithOffset(start, timeZone);
    const endAt = formatDateTimeWithOffset(end, timeZone);
    const seed = `${normalizeText(item.id)}|${startAt}|${endAt}|${title}|${calendarName}|${index}`;
    const event = {
      id: `calendar-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 14)}`,
      startAt,
      endAt,
      title: classification.title || title,
      note: `Apple Calendar 同步：${title}${calendarName ? `（日历：${calendarName}）` : ""}${ranges.length > 1 ? "（跨午夜事件已按日期拆分）" : ""}`,
      categoryId: classification.categoryId,
      subcategoryId: classification.subcategoryId,
      tags: Array.from(new Set([...(classification.tags || []), "apple-calendar"])),
    };
    if (classification.eventNodeId) {
      event.eventNodeId = classification.eventNodeId;
    }
    return event;
  });
}

function splitRangeByLocalDate(startDate, endDate, timeZone) {
  const ranges = [];
  let cursor = startDate;
  while (formatDate(cursor, timeZone) !== formatDate(endDate, timeZone)) {
    const currentDate = formatDate(cursor, timeZone);
    const endOfDay = localDateTimeToDate(`${currentDate}T23:59:59`, timeZone);
    if (!isUsableRange(cursor, endOfDay)) {
      break;
    }
    ranges.push({ start: cursor, end: endOfDay });
    const nextDate = new Date(endOfDay.getTime() + 1_000);
    cursor = nextDate;
  }
  if (isUsableRange(cursor, endDate)) {
    ranges.push({ start: cursor, end: endDate });
  }
  return ranges;
}

function localDateTimeToDate(value, timeZone) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  const desiredUtcMs = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
  let candidateMs = desiredUtcMs;
  for (let index = 0; index < 2; index += 1) {
    const parts = dateParts(new Date(candidateMs), timeZone);
    const representedUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidateMs += desiredUtcMs - representedUtcMs;
  }
  return new Date(candidateMs);
}

function classifyCalendarEvent(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (/(nachtdienst|night\s*shift|夜班)/i.test(normalized)) {
    return classification("夜班 / Nachtdienst", "work", "work.other", "", ["work", "shift", "night-shift"]);
  }
  if (/(frühdienst|fruehdienst|early\s*shift|早班)/i.test(normalized)) {
    return classification("早班 / Frühdienst", "work", "work.other", "", ["work", "shift", "early-shift"]);
  }
  if (/(spätdienst|spaetdienst|late\s*shift|晚班)/i.test(normalized)) {
    return classification("晚班 / Spätdienst", "work", "work.other", "", ["work", "shift", "late-shift"]);
  }
  if (/(^|\n|\s)(arbeit|dienst|shift|上班|班次)($|\n|\s)/i.test(normalized)) {
    return classification("工作班次", "work", "work.other", "", ["work", "shift"]);
  }
  if (/(刷手机|看手机|手机|短视频|小红书|抖音|instagram|tiktok|youtube shorts|reels|scroll)/i.test(normalized)) {
    return classification("刷手机 / 屏幕时间", "entertainment", "entertainment.social_media", "evt.phone_scroll", ["phone", "screen-time"]);
  }
  if (/(weiterbildung|praxisanleitung|praxisleiter|课程|上课|听课|培训|seminar|lesson|course|护理学校|学校|pflegeschule)/i.test(normalized)) {
    return classification("Weiterbildung / 课程学习", "study", "study.course", "evt.learning", ["study", "course"]);
  }
  if (/(德语|deutsch|英语|english|语法|vokabel|单词|学习|练习|复习|论文|paper|阅读)/i.test(normalized)) {
    return classification("学习 / 练习", "study", "study.practice", "", ["study", "practice"]);
  }
  if (/(通勤|出发|到家|回家|车站|地铁|公交|火车|tram|bus|bahn|commute|unterwegs)/i.test(normalized)) {
    return classification("通勤 / 路上时间", "travel", "travel.commute", "evt.commute", ["commute", "transit"]);
  }
  if (/(运动|workout|training|健身|跑步|瑜伽|拉伸|锻炼)/i.test(normalized)) {
    return classification("运动", "exercise", "exercise.workout", "evt.workout", ["exercise"]);
  }
  if (/(走路|散步|walk|步行)/i.test(normalized)) {
    return classification("走路 / 散步", "exercise", "exercise.walk", "evt.walk", ["walk"]);
  }
  if (/(睡|nap|午睡|小睡|休息|躺)/i.test(normalized)) {
    return classification("睡眠 / 休息", "rest", "rest.nap", "evt.nap", ["rest"]);
  }
  if (/(早餐|早饭|午饭|午餐|晚饭|晚餐|吃饭|泡面|面条|外卖|breakfast|lunch|dinner)/i.test(normalized)) {
    return classification("吃饭", "life", "life.meal", chooseMealEventNode(normalized), ["meal"]);
  }
  if (/(写代码|coding|codex|claude code|app|项目|开发|debug|修复)/i.test(normalized)) {
    return classification("项目 / 编程", "work", "work.coding", "evt.focus_coding", ["coding"]);
  }
  return classification(normalizeFirstLine(text) || "日历事件", "life", "life.other", "", ["calendar"]);
}

function classification(title, categoryId, subcategoryId, eventNodeId, tags) {
  return { title, categoryId, subcategoryId, eventNodeId, tags };
}

function chooseMealEventNode(text) {
  if (/(早餐|早饭|breakfast)/i.test(text)) {
    return "evt.breakfast";
  }
  if (/(午饭|午餐|lunch)/i.test(text)) {
    return "evt.lunch";
  }
  if (/(晚饭|晚餐|dinner)/i.test(text)) {
    return "evt.dinner";
  }
  return "";
}

function isUsableRange(startDate, endDate) {
  const durationMinutes = (endDate.getTime() - startDate.getTime()) / 60_000;
  return Number.isFinite(durationMinutes) && durationMinutes >= MIN_EVENT_MINUTES && durationMinutes <= 24 * 60;
}

function formatDateTimeWithOffset(date, timeZone) {
  const parts = dateParts(date, timeZone);
  const offset = getOffsetMinutes(date, timeZone);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const offsetText = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${offsetText}`;
}

function formatDate(date, timeZone) {
  const parts = dateParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
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

function parseDateOrNow(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function groupBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    const group = map.get(key) || [];
    group.push(item);
    map.set(key, group);
  }
  return map;
}

function normalizeFirstLine(value) {
  return normalizeText(value).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

module.exports = { CalendarTimelineSyncService, calendarEventToTimelineEvents };
