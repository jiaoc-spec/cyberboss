const crypto = require("crypto");

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
    for (const item of Array.isArray(readResult?.events) ? readResult.events : []) {
      const event = calendarEventToTimelineEvent(item, timeZone);
      if (event) {
        events.push(event);
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

function calendarEventToTimelineEvent(item, timeZone) {
  if (!item || item.isAllDay) {
    return null;
  }
  const title = normalizeText(item.title);
  const calendarName = normalizeText(item.calendar);
  const startDate = parseDateOrNow(item.start);
  const endDate = parseDateOrNow(item.end);
  if (!title || !isUsableRange(startDate, endDate)) {
    return null;
  }
  const classification = classifyCalendarEvent(`${title}\n${calendarName}\n${normalizeText(item.notes)}`);
  const startAt = formatDateTimeWithOffset(startDate, timeZone);
  const endAt = formatDateTimeWithOffset(endDate, timeZone);
  const seed = `${normalizeText(item.id)}|${startAt}|${endAt}|${title}|${calendarName}`;
  const event = {
    id: `calendar-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 14)}`,
    startAt,
    endAt,
    title: classification.title || title,
    note: `Apple Calendar 同步：${title}${calendarName ? `（日历：${calendarName}）` : ""}`,
    categoryId: classification.categoryId,
    subcategoryId: classification.subcategoryId,
    tags: Array.from(new Set([...(classification.tags || []), "apple-calendar"])),
  };
  if (classification.eventNodeId) {
    event.eventNodeId = classification.eventNodeId;
  }
  return event;
}

function classifyCalendarEvent(text) {
  const normalized = normalizeText(text).toLowerCase();
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

module.exports = { CalendarTimelineSyncService };
