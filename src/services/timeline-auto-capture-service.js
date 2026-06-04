const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIN_EVENT_MINUTES = 3;
const MAX_PENDING_HOURS = 18;

class TimelineAutoCaptureService {
  constructor({ config, timeline }) {
    this.config = config;
    this.timeline = timeline;
  }

  async captureMessage({ text = "", receivedAt = "", senderId = "", provider = "" } = {}) {
    const body = normalizeText(text);
    if (!body || !this.timeline) {
      return { events: [], pending: null };
    }

    const receivedDate = parseDateOrNow(receivedAt);
    const timeZone = this.config.diaryTimeZone || this.config.timeZone || "UTC";
    const localDate = formatDate(receivedDate, timeZone);
    const state = this.loadState();
    const senderKey = normalizeText(senderId) || "default";
    const pendingKey = `${normalizeText(provider) || "channel"}:${senderKey}`;

    const events = [
      ...extractExplicitRangeEvents(body, { receivedDate, timeZone, localDate }),
      ...closePendingEvents(body, {
        pending: state.pending?.[pendingKey],
        receivedDate,
        timeZone,
        localDate,
      }),
    ];

    const nextPending = extractPendingStart(body, { receivedDate, timeZone, localDate });
    if (nextPending) {
      state.pending = state.pending || {};
      state.pending[pendingKey] = nextPending;
    } else if (events.length) {
      clearClosedPending(state, pendingKey, body);
    }

    pruneExpiredPending(state, receivedDate);
    this.saveState(state);

    if (!events.length) {
      return { events: [], pending: nextPending };
    }

    const byDate = groupBy(events, (event) => formatDate(parseDateOrNow(event.startAt), timeZone));
    const written = [];
    for (const [date, dateEvents] of byDate.entries()) {
      await this.timeline.write({
        date,
        events: dateEvents,
        mode: "merge",
      });
      written.push(...dateEvents);
    }
    return { events: written, pending: nextPending };
  }

  loadState() {
    const filePath = normalizeText(this.config.timelineAutoCaptureStateFile);
    if (!filePath || !fs.existsSync(filePath)) {
      return { pending: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : { pending: {} };
    } catch {
      return { pending: {} };
    }
  }

  saveState(state) {
    const filePath = normalizeText(this.config.timelineAutoCaptureStateFile);
    if (!filePath) {
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state || { pending: {} }, null, 2)}\n`, "utf8");
  }
}

function extractExplicitRangeEvents(text, context) {
  if (looksLikeFuturePlan(text)) {
    return [];
  }
  const times = extractTimes(text);
  if (times.length < 2) {
    return [];
  }

  const events = [];
  for (let index = 0; index < times.length - 1; index += 1) {
    const start = times[index];
    const end = times[index + 1];
    const startDate = localTimeToDate(context.localDate, start, context.timeZone);
    const endDate = localTimeToDate(context.localDate, end, context.timeZone);
    if (!isUsableRange(startDate, endDate)) {
      continue;
    }
    const rangeText = extractRangeContext(text, times, index);
    const classification = classifyRangeActivity(rangeText, text);
    events.push(buildEvent({
      startDate,
      endDate,
      timeZone: context.timeZone,
      title: classification.title,
      note: `CyberBoss 自动从消息识别的时间段：${text}`,
      categoryId: classification.categoryId,
      subcategoryId: classification.subcategoryId,
      eventNodeId: classification.eventNodeId,
      tags: classification.tags,
    }));
  }
  return events;
}

function extractPendingStart(text, context) {
  if (looksLikeFuturePlan(text)) {
    return null;
  }
  const isCommute = isCommuteStart(text);
  const isGenericStart = /(开始|start|begin|现在.*(做|学|练|运动|休息|睡)|准备.*开始)/i.test(text);
  if (!isCommute && !isGenericStart) {
    return null;
  }
  if (/(结束|完成|finish|done|end)/i.test(text)) {
    return null;
  }
  const classification = isCommute ? commuteClassification() : classifyActivity(text);
  return {
    startAt: formatDateTimeWithOffset(context.receivedDate, context.timeZone),
    localDate: context.localDate,
    text,
    classification,
    createdAt: new Date().toISOString(),
  };
}

function closePendingEvents(text, context) {
  const pending = context.pending;
  if (!pending?.startAt) {
    return [];
  }
  const pendingClassification = pending.classification || {};
  const closesGenericActivity = /(结束|完成|做完|学完|练完|finish|done|end)/i.test(text);
  const closesCommute = pendingClassification.subcategoryId === "travel.commute" && isCommuteArrival(text);
  if (!closesGenericActivity && !closesCommute) {
    return [];
  }

  const startDate = parseDateOrNow(pending.startAt);
  const endDate = context.receivedDate;
  if (!isUsableRange(startDate, endDate)) {
    return [];
  }

  const classification = preferSpecificClassification(
    closesCommute ? commuteClassification() : classifyActivity(`${pending.text || ""}\n${text}`),
    pending.classification
  );
  return [
    buildEvent({
      startDate,
      endDate,
      timeZone: context.timeZone,
      title: classification.title,
      note: `CyberBoss 自动配对开始/结束消息。\n开始：${pending.text || ""}\n结束：${text}`,
      categoryId: classification.categoryId,
      subcategoryId: classification.subcategoryId,
      eventNodeId: classification.eventNodeId,
      tags: classification.tags,
    }),
  ];
}

function clearClosedPending(state, pendingKey, text) {
  const pendingClassification = state.pending?.[pendingKey]?.classification || {};
  const closesGenericActivity = /(结束|完成|做完|学完|练完|finish|done|end)/i.test(text);
  const closesCommute = pendingClassification.subcategoryId === "travel.commute" && isCommuteArrival(text);
  if ((closesGenericActivity || closesCommute) && state.pending?.[pendingKey]) {
    delete state.pending[pendingKey];
  }
}

function pruneExpiredPending(state, nowDate) {
  const pending = state.pending || {};
  for (const [key, value] of Object.entries(pending)) {
    const start = parseDateOrNow(value?.startAt);
    const ageHours = (nowDate.getTime() - start.getTime()) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > MAX_PENDING_HOURS) {
      delete pending[key];
    }
  }
}

function classifyActivity(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (/(通勤|出发|到家|回家|车站|地铁|公交|火车|tram|bus|bahn|commute|unterwegs)/i.test(normalized)) {
    return commuteClassification();
  }
  if (/(weiterbildung|praxisanleitung|praxisleiter|课程|上课|听课|培训|seminar|lesson|course)/i.test(normalized)) {
    return classification("Weiterbildung / 课程学习", "study", "study.course", "evt.learning", ["study", "course"]);
  }
  if (/(德语|deutsch|英语|english|语法|vokabel|单词|学习|练习|复习|论文|paper|阅读)/i.test(normalized)) {
    return classification("学习 / 练习", "study", "study.practice", "", ["study", "practice"]);
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
  if (/(刷手机|看手机|短视频|小红书|抖音|instagram|tiktok|scroll)/i.test(normalized)) {
    return classification("刷手机", "entertainment", "entertainment.social_media", "evt.phone_scroll", ["phone"]);
  }
  if (/(早餐|早饭|午饭|午餐|晚饭|晚餐|吃饭|泡面|面条|外卖|breakfast|lunch|dinner)/i.test(normalized)) {
    return classification("吃饭", "life", "life.meal", chooseMealEventNode(normalized), ["meal"]);
  }
  if (/(写代码|coding|codex|claude code|app|项目|开发|debug|修复)/i.test(normalized)) {
    return classification("项目 / 编程", "work", "work.coding", "evt.focus_coding", ["coding"]);
  }
  return classification("生活记录", "life", "life.other", "", ["auto-captured"]);
}

function classification(title, categoryId, subcategoryId, eventNodeId, tags) {
  return { title, categoryId, subcategoryId, eventNodeId, tags };
}

function commuteClassification() {
  return classification("通勤 / 路上时间", "travel", "travel.commute", "evt.commute", ["commute", "transit"]);
}

function classifyRangeActivity(rangeText, fullText) {
  const context = normalizeText(rangeText);
  const combined = `${context}\n${normalizeText(fullText)}`;
  if (/(出发|离开|去|前往|车站|地铁|公交|火车|tram|bus|bahn|到家|回家|unterwegs)/i.test(context)) {
    return commuteClassification();
  }
  if (/(下课|课程结束|培训结束|weiterbildung.*结束|class.*end)/i.test(context) && /(到家|回家|车站|地铁|公交|火车|tram|bus|bahn)/i.test(context)) {
    return commuteClassification();
  }
  if (/(weiterbildung|praxisanleitung|praxisleiter|课程|上课|听课|培训|seminar|lesson|course|护理学校|学校|pflegeschule)/i.test(combined)) {
    return classification("Weiterbildung / 课程学习", "study", "study.course", "evt.learning", ["study", "course"]);
  }
  return classifyActivity(combined);
}

function isCommuteStart(text) {
  return /(出发了?|离开了?|在路上|去(护理学校|学校|上课|车站|上班|医院|praxis|pflegeschule)|前往|unterwegs|on my way)/i.test(text);
}

function isCommuteArrival(text) {
  return /(到家了?|回到家|到(护理学校|学校|车站|公司|医院|praxis|pflegeschule)了?|到了|arrived|ankommen|angekommen)/i.test(text);
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

function preferSpecificClassification(current, previous) {
  if (!previous) {
    return current;
  }
  if (current.subcategoryId && current.subcategoryId !== "life.other") {
    return current;
  }
  return previous;
}

function buildEvent({ startDate, endDate, timeZone, title, note, categoryId, subcategoryId, eventNodeId, tags }) {
  const startAt = formatDateTimeWithOffset(startDate, timeZone);
  const endAt = formatDateTimeWithOffset(endDate, timeZone);
  const seed = `${startAt}|${endAt}|${title}|${subcategoryId}`;
  const event = {
    id: `cyberboss-auto-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12)}`,
    startAt,
    endAt,
    title,
    note,
    categoryId,
    subcategoryId,
    tags: Array.from(new Set([...(tags || []), "cyberboss-auto"])),
  };
  if (eventNodeId) {
    event.eventNodeId = eventNodeId;
  }
  return event;
}

function extractTimes(text) {
  const times = [];
  const pattern = /(?<!\d)([01]?\d|2[0-3])[:：点时]([0-5]\d)?(?:分)?(?!\d)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      times.push({ hour, minute, index: match.index, endIndex: pattern.lastIndex });
    }
  }
  return times;
}

function extractRangeContext(text, times, index) {
  const start = times[index];
  const end = times[index + 1];
  const nextStart = times[index + 2]?.index ?? text.length;
  const beforeStart = index === 0 ? text.slice(0, start.index) : "";
  const between = text.slice(start.endIndex, end.index);
  const afterEnd = text.slice(end.endIndex, nextStart);
  return `${beforeStart} ${between} ${afterEnd}`.trim();
}

function looksLikeFuturePlan(text) {
  return /(待会|等一下|一会儿|明天|后天|可能|希望|打算|计划|安排|预计|闹钟|提醒我|必须|到时候|睡觉前|睡前|remind me|will|maybe|tomorrow)/i.test(text);
}

function isUsableRange(startDate, endDate) {
  const durationMinutes = (endDate.getTime() - startDate.getTime()) / 60_000;
  return Number.isFinite(durationMinutes) && durationMinutes >= MIN_EVENT_MINUTES && durationMinutes <= 24 * 60;
}

function localTimeToDate(localDate, time, timeZone) {
  const [year, month, day] = localDate.split("-").map((part) => Number(part));
  const guess = new Date(Date.UTC(year, month - 1, day, time.hour, time.minute, 0));
  const offsetMinutes = getOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offsetMinutes * 60_000);
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pad(value) {
  return String(value).padStart(2, "0");
}

module.exports = { TimelineAutoCaptureService };
