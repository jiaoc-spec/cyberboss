const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const CORE_DATA_EPOCH_SECONDS = 978_307_200;
const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  "Library/Group Containers/8774ZX9976.3x3.today/Model_3x3.sqlite/Model_3x3.sqlite",
);

class Today3x3TimelineSyncService {
  constructor({ config, timeline } = {}) {
    this.config = config || {};
    this.timeline = timeline;
    this.lastError = null;
  }

  async sync({ start = "", end = "", days = 0, now = new Date() } = {}) {
    if (!this.timeline) {
      return { imported: [], skipped: 0, reason: "no_timeline" };
    }
    const databasePath = resolveToday3x3DatabasePath(this.config);
    if (!fs.existsSync(databasePath)) {
      return { imported: [], skipped: 0, reason: "no_database", databasePath };
    }

    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const dates = resolveDateRange({ start, end, days: days || this.config.today3x3TimelineSyncDays || 2, now, timeZone });
    const imported = [];
    let skipped = 0;
    for (const date of dates) {
      const rows = this.readRowsForDate({ date, timeZone, databasePath });
      const events = scheduleRowsToTimelineEvents(rows, { date, timeZone });
      skipped += rows.length - countSourceRows(events);
      const existing = await this.timeline.read({ date }).catch(() => ({ data: { events: [] } }));
      const incomingIds = new Set(events.map((event) => String(event.id || "").trim()).filter(Boolean));
      const dropEventIds = collectDropEventIds(existing?.data?.events || [])
        .filter((eventId) => !incomingIds.has(eventId));
      await this.timeline.write({
        date,
        events,
        mode: "merge",
        dropEventIds,
        source: { provider: "today-3x3", databasePath },
      });
      imported.push(...events);
    }
    return { provider: "today-3x3", databasePath, imported, skipped, dates };
  }

  readRowsForDate({ date, timeZone, databasePath }) {
    const dayStart = localDateTimeToDate(`${date}T00:00:00`, timeZone);
    const nextDay = addDaysText(date, 1);
    const dayEnd = localDateTimeToDate(`${nextDay}T00:00:00`, timeZone);
    const startCore = toCoreDataSeconds(dayStart);
    const endCore = toCoreDataSeconds(dayEnd);
    const sql = [
      "SELECT",
      "Z_PK AS id,",
      "ZIS_CANCEL AS isCancel,",
      "ZIS_USE AS isUse,",
      "ZSCHEDULE_TYPE AS scheduleType,",
      "ZCREATE_DATE AS startCore,",
      "ZEND_DATE AS endCore,",
      "ZTHING AS title",
      "FROM ZSCHEDULEENTITY",
      "WHERE ZCREATE_DATE IS NOT NULL",
      "AND ZEND_DATE IS NOT NULL",
      "AND ZEND_DATE > ZCREATE_DATE",
      `AND ZCREATE_DATE < ${endCore}`,
      `AND ZEND_DATE > ${startCore}`,
      "ORDER BY ZCREATE_DATE ASC;",
    ].join(" ");
    return runSqliteJson({
      sqliteBin: this.config.today3x3SqliteBin || "sqlite3",
      databasePath,
      sql,
      timeoutMs: this.config.today3x3SqliteTimeoutMs || 20_000,
    }).map((row) => ({
      id: Number(row.id),
      title: normalizeText(row.title),
      startAt: fromCoreDataSeconds(Number(row.startCore)),
      endAt: fromCoreDataSeconds(Number(row.endCore)),
      isCancel: Number(row.isCancel || 0),
      isUse: Number(row.isUse || 0),
      scheduleType: Number(row.scheduleType || 0),
    }));
  }
}

function scheduleRowsToTimelineEvents(rows, { date, timeZone }) {
  const dayStart = localDateTimeToDate(`${date}T00:00:00`, timeZone);
  const dayEnd = localDateTimeToDate(`${addDaysText(date, 1)}T00:00:00`, timeZone);
  const lastMomentInDay = new Date(dayEnd.getTime() - 1_000);
  const clipped = rows
    .filter((row) => row && row.startAt instanceof Date && row.endAt instanceof Date)
    .map((row) => ({
      ...row,
      startAt: new Date(Math.max(row.startAt.getTime(), dayStart.getTime())),
      endAt: new Date(Math.min(row.endAt.getTime(), lastMomentInDay.getTime())),
    }))
    .filter((row) => row.endAt.getTime() - row.startAt.getTime() >= 1_000);

  const phoneRows = clipped.filter((row) => classify3x3Title(row.title).kind === "phone");
  const otherRows = clipped.filter((row) => classify3x3Title(row.title).kind !== "phone");
  return [
    ...phoneRowsToUnionEvents(phoneRows, { date, timeZone }),
    ...otherRows.map((row) => rowToTimelineEvent(row, { date, timeZone })),
  ].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt) || left.id.localeCompare(right.id));
}

function phoneRowsToUnionEvents(rows, { date, timeZone }) {
  const intervals = mergeIntervals(rows.map((row) => ({
    startAt: row.startAt,
    endAt: row.endAt,
    sourceIds: [row.id],
  })));
  return intervals.map((interval, index) => {
    const sourceIds = interval.sourceIds.filter((id) => Number.isFinite(id));
    const exactMinutes = Math.round(((interval.endAt.getTime() - interval.startAt.getTime()) / 60_000) * 10) / 10;
    const startAt = formatDateTimeWithOffset(interval.startAt, timeZone);
    const endAt = formatDateTimeWithOffset(interval.endAt, timeZone);
    return {
      id: `3x3-phone-${hash([date, startAt, endAt, sourceIds.join(",")].join("|")).slice(0, 16)}`,
      startAt,
      endAt,
      title: "刷手机 / 屏幕时间",
      note: `Today 3x3 去重屏幕时间：${exactMinutes} 分钟；同一时段多设备只算一次；sourceRows=${sourceIds.join(",") || index + 1}`,
      categoryId: "entertainment",
      subcategoryId: "entertainment.social_media",
      eventNodeId: "evt.phone_scroll",
      tags: ["3x3", "today-3x3", "phone", "screen-time"],
    };
  });
}

function rowToTimelineEvent(row, { date, timeZone }) {
  const classification = classify3x3Title(row.title);
  const startAt = formatDateTimeWithOffset(row.startAt, timeZone);
  const endAt = formatDateTimeWithOffset(row.endAt, timeZone);
  return {
    id: `3x3-${hash([row.id, date, startAt, endAt, row.title].join("|")).slice(0, 18)}`,
    startAt,
    endAt,
    title: classification.title,
    note: `Today 3x3 同步：${row.title || classification.title}`,
    categoryId: classification.categoryId,
    subcategoryId: classification.subcategoryId,
    ...(classification.eventNodeId ? { eventNodeId: classification.eventNodeId } : {}),
    tags: Array.from(new Set(["3x3", "today-3x3", ...classification.tags])),
  };
}

function classify3x3Title(value) {
  const title = normalizeText(value);
  const normalized = title.toLowerCase();
  if (/(📱|刷手机|看手机|手机|screen\s*time|scroll|instagram|tiktok|小红书|抖音|youtube shorts|reels)/i.test(normalized)) {
    return classification("phone", "刷手机 / 屏幕时间", "entertainment", "entertainment.social_media", "evt.phone_scroll", ["phone", "screen-time"]);
  }
  if (/(睡|sleep|nap|补觉|休息|躺|schlaf)/i.test(normalized)) {
    return classification("rest", cleanTitle(title) || "睡眠 / 休息", "rest", "rest.nap", "evt.nap", ["rest"]);
  }
  if (/(通勤|出发|到家|回家|路上|bus|bahn|tram|commute|unterwegs)/i.test(normalized)) {
    return classification("commute", cleanTitle(title) || "通勤 / 路上时间", "travel", "travel.commute", "evt.commute", ["commute", "transit"]);
  }
  if (/(运动|健身|力量|有氧|workout|training|跑步|锻炼|拉伸)/i.test(normalized)) {
    return classification("exercise", cleanTitle(title) || "运动", "exercise", "exercise.workout", "evt.workout", ["exercise"]);
  }
  if (/(走路|散步|walk|步行)/i.test(normalized)) {
    return classification("walk", cleanTitle(title) || "走路 / 散步", "exercise", "exercise.walk", "evt.walk", ["walk"]);
  }
  if (/(德语|deutsch|英语|english|语法|shadow|影子跟读|学习|阅读|论文|paper|课程|weiterbildung|praxisanleitung)/i.test(normalized)) {
    return classification("study", cleanTitle(title) || "学习 / 练习", "study", "study.practice", "evt.learning", ["study", "practice"]);
  }
  if (/(上班|班次|arbeit|dienst|shift|夜班|早班|晚班)/i.test(normalized)) {
    return classification("work", cleanTitle(title) || "工作班次", "work", "work.other", "", ["work", "shift"]);
  }
  if (/(coding|codex|claude|开发|写代码|项目|debug)/i.test(normalized)) {
    return classification("coding", cleanTitle(title) || "项目 / 编程", "work", "work.coding", "evt.focus_coding", ["coding"]);
  }
  if (/(早餐|午饭|晚饭|吃饭|breakfast|lunch|dinner)/i.test(normalized)) {
    return classification("meal", cleanTitle(title) || "吃饭", "life", "life.meal", "", ["meal"]);
  }
  return classification("life", cleanTitle(title) || "3x3 时间记录", "life", "life.other", "", ["3x3"]);
}

function collectDropEventIds(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => {
      const tags = Array.isArray(event?.tags) ? event.tags : [];
      const id = String(event?.id || "");
      return id.startsWith("3x3-") || (tags.includes("apple-calendar") && (tags.includes("phone") || tags.includes("screen-time")));
    })
    .map((event) => String(event.id || "").trim())
    .filter(Boolean);
}

function countSourceRows(events) {
  return events.reduce((sum, event) => {
    const match = String(event.note || "").match(/sourceRows=([0-9,]+)/);
    if (match) {
      return sum + match[1].split(",").filter(Boolean).length;
    }
    return sum + 1;
  }, 0);
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((item) => item?.startAt instanceof Date && item?.endAt instanceof Date && item.endAt > item.startAt)
    .sort((left, right) => left.startAt - right.startAt || left.endAt - right.endAt);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.startAt.getTime() <= last.endAt.getTime()) {
      if (item.endAt.getTime() > last.endAt.getTime()) {
        last.endAt = item.endAt;
      }
      last.sourceIds.push(...item.sourceIds);
    } else {
      merged.push({ startAt: item.startAt, endAt: item.endAt, sourceIds: [...item.sourceIds] });
    }
  }
  return merged;
}

function runSqliteJson({ sqliteBin, databasePath, sql, timeoutMs }) {
  const result = spawnSync(sqliteBin, ["-readonly", "-cmd", ".timeout 10000", "-json", databasePath, sql], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`today3x3 sqlite failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  const body = String(result.stdout || "").trim();
  return body ? JSON.parse(body) : [];
}

function resolveToday3x3DatabasePath(config = {}) {
  const configured = normalizeText(config.today3x3DatabasePath);
  if (!configured) {
    return DEFAULT_DB_PATH;
  }
  if (fs.existsSync(configured) && fs.statSync(configured).isDirectory()) {
    return path.join(configured, "Model_3x3.sqlite");
  }
  return configured;
}

function resolveDateRange({ start = "", end = "", days = 2, now = new Date(), timeZone = "UTC" }) {
  const endDate = normalizeDateText(end) || localDateText(now, timeZone);
  const startDate = normalizeDateText(start) || addDaysText(endDate, -(Math.max(1, Number(days) || 2) - 1));
  const dates = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    dates.push(cursor);
    cursor = addDaysText(cursor, 1);
  }
  return dates;
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

function localDateText(date, timeZone) {
  const parts = dateParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function formatDateTimeWithOffset(date, timeZone) {
  const parts = dateParts(date, timeZone);
  const offset = getOffsetMinutes(date, timeZone);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
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

function toCoreDataSeconds(date) {
  return Math.floor(date.getTime() / 1000) - CORE_DATA_EPOCH_SECONDS;
}

function fromCoreDataSeconds(value) {
  return new Date((Number(value) + CORE_DATA_EPOCH_SECONDS) * 1000);
}

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeDateText(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function classification(kind, title, categoryId, subcategoryId, eventNodeId, tags) {
  return { kind, title, categoryId, subcategoryId, eventNodeId, tags };
}

function cleanTitle(value) {
  return normalizeText(value)
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "")
    .trim();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  Today3x3TimelineSyncService,
  classify3x3Title,
  collectDropEventIds,
  mergeIntervals,
  resolveToday3x3DatabasePath,
  scheduleRowsToTimelineEvents,
};
