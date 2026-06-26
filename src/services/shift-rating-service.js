const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");

const SHIFT_END_PATTERN = /(下班了?|下班啦|刚下班|下了(?:早班|晚班|夜班|班)|交班|交完班|夜班结束|班结束|下夜班|off\s*work|shift\s*ended|feierabend)/i;
const EXPLICIT_OFF_WORK_TIME_PATTERN = /(?:\b\d{1,2}[:：]\d{2}|\b\d{1,2}\s*点\s*\d{0,2}|[零一二三四五六七八九十两]{1,4}\s*点(?:半|[零一二三四五六七八九十]{0,3})?)\s*(?:下班|交班)/;
const FUTURE_MARKER_PATTERN = /(明天|后天|今晚|待会|等下|一会儿|之后|到时候|准备|计划|打算|要去|会在|will|tomorrow|later)/i;
const SCORE_PATTERN = /(?:^|[^\d])(?:10|[0-9](?:\.[0-9])?)\s*分(?:吧|左右|多|了|，|。|,|\.|\s|$)|(?:^|[^\d])(?:10|[0-9](?:\.[0-9])?)\s*\/\s*10(?:\D|$)|(?:疲惫|疲劳|累|能量|状态|打分|分数).{0,12}(?:10|[0-9](?:\.[0-9])?)/;
const DEFAULT_COOLDOWN_MS = 8 * 60 * 60_000;
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_AFTER_SHIFT_DELAY_MINUTES = 8;
const DEFAULT_AFTER_SHIFT_WINDOW_MINUTES = 180;

class ShiftRatingService {
  constructor({ config, channelAdapter, dailyState = null, sessionStore = null, proactiveIntervention = null } = {}) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.dailyState = dailyState;
    this.sessionStore = sessionStore;
    this.proactiveIntervention = proactiveIntervention;
    this.lastCheckAtMs = 0;
  }

  async observeIncoming(normalized = {}) {
    if (this.config.shiftRatingEnabled === false) {
      return { handled: false };
    }
    const text = normalizeText(normalized.text);
    if (!text || !normalized.senderId || !normalized.contextToken) {
      return { handled: false };
    }
    const now = parseDateOrNow(normalized.receivedAt);
    const date = formatDate(now, this.timeZone());
    const state = this.loadState();
    const senderKey = `${normalizeText(normalized.provider) || "channel"}:${normalizeText(normalized.senderId)}`;
    const pendingPrompt = hasUnansweredPrompt(state, senderKey);

    if (pendingPrompt && looksLikePendingScoreAnswer(text)) {
      markAnswered(state, senderKey, date, text, now);
      this.saveState(state);
      const latest = state.lastPromptBySender?.[senderKey] || {};
      const scoreText = Number.isFinite(Number(latest.score)) ? `${latest.score}/10` : "unknown";
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        text: `好，疲惫感 ${scoreText}，我记下来了。先按这个体感来照顾今晚，不把它放大成别的意思。`,
      });
      return { handled: true, answered: true };
    }

    if (looksLikeScore(text)) {
      markAnswered(state, senderKey, date, text, now);
      this.saveState(state);
      return { handled: Boolean(pendingPrompt), answered: Boolean(pendingPrompt) };
    }

    if (!looksLikeShiftEnded(text)) {
      return { handled: false };
    }
    if (looksLikeFutureShiftPlan(text)) {
      return { handled: false };
    }
    if (wasRecentlyPrompted(state, senderKey, now, this.cooldownMs())) {
      return { handled: false };
    }

    const prompt = buildShiftRatingPrompt(text);
    const entry = buildPromptEntry({
      date,
      senderKey,
      text,
      now,
      triggerType: "user_shift_end",
      shiftKey: `manual:${date}:${hashText(text)}`,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      text: prompt,
    });
    recordPrompt(state, senderKey, entry);
    this.saveState(state);
    return { handled: true, prompt };
  }

  async check(account, now = new Date()) {
    if (this.config.shiftRatingEnabled === false || this.config.shiftRatingAutoPromptEnabled === false) {
      return { prompted: [] };
    }
    if (!this.dailyState || typeof this.dailyState.analyze !== "function" || !this.channelAdapter) {
      return { prompted: [] };
    }
    const intervalMs = this.checkIntervalMs();
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { prompted: [] };
    }
    this.lastCheckAtMs = now.getTime();

    const target = this.resolveTarget(account);
    if (!target.senderId || !target.contextToken) {
      return { prompted: [] };
    }

    const local = localDateParts(now, this.timeZone());
    const state = this.loadState();
    if (hasUnansweredPrompt(state, target.senderKey)) {
      return { prompted: [] };
    }

    const analysis = await this.dailyState.analyze({ date: local.date, now });
    const dueShift = findDueCompletedShift({
      analysis,
      now,
      date: local.date,
      config: this.config,
      state,
      senderKey: target.senderKey,
    });
    if (!dueShift) {
      return { prompted: [] };
    }

    const reservation = this.proactiveIntervention?.request?.({
      source: "shift_rating",
      category: "reflection",
      priority: "hard_boundary",
      subject: dueShift.shiftKey,
      accountId: account?.accountId || "",
      senderId: target.senderId,
      provider: this.channelAdapter?.describe?.().id || "channel",
      now,
      bypassProtections: false,
    });
    if (reservation && !reservation.allowed) {
      return { prompted: [], deferred: `proactive_${reservation.reason}` };
    }

    const prompt = buildShiftRatingPrompt(dueShift.promptText);
    const entry = buildPromptEntry({
      date: local.date,
      senderKey: target.senderKey,
      text: dueShift.promptText,
      now,
      triggerType: "calendar_shift_end",
      shiftKey: dueShift.shiftKey,
      shiftKind: dueShift.shiftKind,
      event: dueShift.event,
    });
    recordPrompt(state, target.senderKey, entry);
    this.saveState(state);
    await this.channelAdapter.sendText({
      userId: target.senderId,
      contextToken: target.contextToken,
      text: prompt,
    });
    console.log(`[cyberboss] shift rating auto prompted shift=${dueShift.shiftKind} end=${dueShift.event?.end || ""}`);
    return { prompted: [entry] };
  }

  resolveTarget(account) {
    const contextTokens = typeof this.channelAdapter?.getKnownContextTokens === "function"
      ? this.channelAdapter.getKnownContextTokens()
      : {};
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: account?.accountId || "",
      sessionStore: this.sessionStore,
      contextTokens,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: account?.accountId || "",
      senderId,
      sessionStore: this.sessionStore,
    });
    const provider = this.channelAdapter?.describe?.().id || "channel";
    return {
      senderId,
      senderKey: `${provider}:${senderId}`,
      workspaceRoot,
      contextToken: contextTokens[senderId] || "",
    };
  }

  checkIntervalMs() {
    const value = Number(this.config.shiftRatingCheckIntervalMs);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHECK_INTERVAL_MS;
  }

  cooldownMs() {
    const value = Number(this.config.shiftRatingCooldownMs);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_COOLDOWN_MS;
  }

  timeZone() {
    return this.config.diaryTimeZone || this.config.timeZone || "UTC";
  }

  loadState() {
    const filePath = normalizeText(this.config.shiftRatingStateFile);
    if (!filePath || !fs.existsSync(filePath)) {
      return { schemaVersion: 2, lastPromptBySender: {}, entries: [] };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return normalizeState(parsed);
    } catch {
      return { schemaVersion: 2, lastPromptBySender: {}, entries: [] };
    }
  }

  saveState(state) {
    const filePath = normalizeText(this.config.shiftRatingStateFile);
    if (!filePath) {
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
  }
}

function looksLikeShiftEnded(text) {
  const body = normalizeText(text);
  return SHIFT_END_PATTERN.test(body) || EXPLICIT_OFF_WORK_TIME_PATTERN.test(body);
}

function looksLikeFutureShiftPlan(text) {
  const body = normalizeText(text);
  if (!FUTURE_MARKER_PATTERN.test(body)) {
    return false;
  }
  return !/(已经|刚|刚刚|现在|到家|坐车回家|回家路上|结束了)/.test(body);
}

function looksLikeScore(text) {
  return SCORE_PATTERN.test(normalizeText(text));
}

function looksLikePendingScoreAnswer(text) {
  const body = normalizeText(text);
  return looksLikeScore(body) || /^(?:10|[0-9](?:\.[0-9])?)(?:\s*分)?\s*(?:吧|左右|多|了)?$/i.test(body);
}

function hasUnansweredPrompt(state, senderKey) {
  const normalized = normalizeState(state);
  const previous = normalized?.lastPromptBySender?.[senderKey];
  return Boolean(previous?.promptedAt && !previous?.answeredAt);
}

function wasRecentlyPrompted(state, senderKey, now, cooldownMs) {
  const normalized = normalizeState(state);
  const previous = normalized?.lastPromptBySender?.[senderKey];
  const promptedMs = Date.parse(previous?.promptedAt || "");
  return Number.isFinite(promptedMs) && now.getTime() - promptedMs < cooldownMs && !previous?.answeredAt;
}

function markAnswered(state, senderKey, date, text, now) {
  const normalized = normalizeState(state);
  state.schemaVersion = normalized.schemaVersion;
  state.lastPromptBySender = normalized.lastPromptBySender;
  state.entries = normalized.entries;
  const previous = state?.lastPromptBySender?.[senderKey];
  if (!previous) {
    return;
  }
  const score = parseFatigueScore(text);
  const answered = {
    ...previous,
    date: previous.date || date,
    answeredAt: now.toISOString(),
    answerText: text,
    score,
    fatigueBand: classifyFatigue(score),
  };
  state.lastPromptBySender[senderKey] = answered;
  const index = state.entries.findIndex((entry) => entry.id && entry.id === previous.id);
  if (index >= 0) {
    state.entries[index] = { ...state.entries[index], ...answered };
  }
}

function buildShiftRatingPrompt(text) {
  const isNightShift = /夜班|下夜班|night|nacht/i.test(text);
  const opening = isNightShift ? "夜班收住了，辛苦了宝。" : "下班啦，辛苦了宝。";
  return [
    opening,
    "先不用复盘一大堆，给我一个数就行：现在疲惫感 0 到 10 大概几分？",
    "我想把这班结束后的真实体感留住，后面好更懂怎么照顾你。",
  ].join("\n");
}

function buildPromptEntry({ date, senderKey, text, now, triggerType, shiftKey, shiftKind = "", event = null }) {
  return {
    id: `shift-rating-${hashText(`${senderKey}:${date}:${shiftKey}:${now.toISOString()}`)}`,
    date,
    senderKey,
    text,
    promptedAt: now.toISOString(),
    answeredAt: "",
    answerText: "",
    score: null,
    fatigueBand: "unknown",
    triggerType,
    shiftKey,
    shiftKind,
    event: event ? {
      title: normalizeText(event.title),
      calendar: normalizeText(event.calendar),
      startDate: normalizeText(event.startDate),
      endDate: normalizeText(event.endDate),
      start: normalizeText(event.start),
      end: normalizeText(event.end),
    } : null,
  };
}

function recordPrompt(state, senderKey, entry) {
  const normalized = normalizeState(state);
  state.schemaVersion = normalized.schemaVersion;
  state.lastPromptBySender = normalized.lastPromptBySender;
  state.entries = normalized.entries;
  state.lastPromptBySender[senderKey] = entry;
  const existing = state.entries.findIndex((item) => item.id === entry.id);
  if (existing >= 0) {
    state.entries[existing] = entry;
  } else {
    state.entries.push(entry);
  }
  state.entries = pruneEntries(state.entries);
}

function normalizeState(value) {
  const parsed = value && typeof value === "object" ? value : {};
  const lastPromptBySender = parsed.lastPromptBySender && typeof parsed.lastPromptBySender === "object"
    ? parsed.lastPromptBySender
    : {};
  const fromLastPrompt = Object.entries(lastPromptBySender)
    .map(([senderKey, entry]) => normalizeShiftRatingEntry(senderKey, entry))
    .filter((entry) => entry.promptedAt);
  const entries = Array.isArray(parsed.entries)
    ? parsed.entries.map((entry) => normalizeShiftRatingEntry(entry.senderKey, entry)).filter((entry) => entry.promptedAt)
    : [];
  const mergedById = new Map();
  for (const entry of [...fromLastPrompt, ...entries]) {
    const id = normalizeText(entry.id) || `shift-rating-${hashText(`${entry.senderKey}:${entry.date}:${entry.promptedAt}:${entry.text}`)}`;
    mergedById.set(id, { ...entry, id });
  }
  const mergedEntries = pruneEntries(Array.from(mergedById.values()));
  const latestBySender = {};
  for (const entry of mergedEntries) {
    const current = latestBySender[entry.senderKey];
    if (!current || Date.parse(entry.promptedAt) > Date.parse(current.promptedAt || "")) {
      latestBySender[entry.senderKey] = entry;
    }
  }
  return {
    schemaVersion: 2,
    lastPromptBySender: Object.keys(latestBySender).length ? latestBySender : lastPromptBySender,
    entries: mergedEntries,
  };
}

function pruneEntries(entries) {
  const cutoff = Date.now() - 120 * 24 * 60 * 60_000;
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => {
      const prompted = Date.parse(entry.promptedAt || "");
      return !Number.isFinite(prompted) || prompted >= cutoff;
    })
    .sort((left, right) => Date.parse(left.promptedAt || "") - Date.parse(right.promptedAt || ""));
}

function findDueCompletedShift({ analysis, now, date, config = {}, state, senderKey }) {
  const local = localDateParts(now, analysis?.timeZone || config.timeZone || config.diaryTimeZone || "UTC");
  const events = Array.isArray(analysis?.temporalContext?.scheduleEventsToday)
    ? analysis.temporalContext.scheduleEventsToday
    : [];
  const currentEvent = analysis?.temporalContext?.currentEvent || null;
  if (currentEvent && normalizeText(currentEvent.end) > `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`) {
    return null;
  }
  const delay = readPositiveInt(config.shiftRatingAfterShiftDelayMinutes, DEFAULT_AFTER_SHIFT_DELAY_MINUTES);
  const window = readPositiveInt(config.shiftRatingAfterShiftWindowMinutes, DEFAULT_AFTER_SHIFT_WINDOW_MINUTES);
  const nowMinutes = local.hour * 60 + local.minute;
  const candidates = events
    .map((event) => ({ event, shiftKind: detectShiftKind(event) }))
    .filter((item) => item.shiftKind)
    .filter((item) => normalizeText(item.event.endDate || date) === date)
    .map((item) => {
      const endMinutes = parseTimeToMinutes(item.event.end);
      const shiftKey = buildShiftKey(date, item.event, item.shiftKind);
      return { ...item, endMinutes, shiftKey };
    })
    .filter((item) => item.endMinutes !== null)
    .filter((item) => nowMinutes >= item.endMinutes + delay && nowMinutes <= item.endMinutes + window)
    .filter((item) => !hasPromptForShift(state, senderKey, item.shiftKey))
    .sort((left, right) => right.endMinutes - left.endMinutes);
  const candidate = candidates[0];
  if (!candidate) {
    return null;
  }
  return {
    ...candidate,
    promptText: `${candidate.event.end || ""} ${labelShiftKind(candidate.shiftKind)}下班`,
  };
}

function detectShiftKind(event) {
  const text = [event?.title, event?.calendar].filter(Boolean).join(" ");
  if (/(nachtdienst|nachtwache|night\s*shift|夜班)/i.test(text)) return "night";
  if (/(frühdienst|fruehdienst|early\s*shift|早班)/i.test(text)) return "early";
  if (/(spätdienst|spaetdienst|late\s*shift|晚班)/i.test(text)) return "late";
  if (/(dienst|shift|schicht|arbeit|上班|工作|值班)/i.test(text)) return "work";
  return "";
}

function labelShiftKind(kind) {
  if (kind === "night") return "夜班";
  if (kind === "early") return "早班";
  if (kind === "late") return "晚班";
  return "";
}

function buildShiftKey(date, event, shiftKind) {
  return [
    date,
    shiftKind,
    normalizeText(event?.title),
    normalizeText(event?.startDate),
    normalizeText(event?.start),
    normalizeText(event?.endDate),
    normalizeText(event?.end),
  ].join("|");
}

function hasPromptForShift(state, senderKey, shiftKey) {
  const normalized = normalizeState(state);
  return normalized.entries.some((entry) => (
    entry.senderKey === senderKey
    && entry.shiftKey === shiftKey
    && entry.promptedAt
  ));
}

function parseFatigueScore(text) {
  const body = normalizeText(text);
  const matches = [...body.matchAll(/(?:10|[0-9](?:\.[0-9])?)/g)]
    .map((match) => Number.parseFloat(match[0]))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 10);
  return matches.length ? matches[0] : null;
}

function classifyFatigue(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return "unknown";
  if (value <= 3) return "low";
  if (value <= 6) return "medium";
  return "high";
}

function readShiftRatingForDate(filePath, date) {
  const normalized = normalizeText(filePath);
  if (!normalized || !fs.existsSync(normalized)) {
    return { found: false, score: null, fatigueBand: "unknown", entries: [] };
  }
  try {
    const parsed = normalizeState(JSON.parse(fs.readFileSync(normalized, "utf8")));
    const entries = parsed.entries
      .filter((entry) => entry.date === date && entry.answeredAt)
      .sort((left, right) => Date.parse(right.answeredAt) - Date.parse(left.answeredAt));
    const latest = entries[0];
    return latest
      ? { found: true, score: latest.score, fatigueBand: latest.fatigueBand, latest, entries }
      : { found: false, score: null, fatigueBand: "unknown", entries: [] };
  } catch {
    return { found: false, score: null, fatigueBand: "unknown", entries: [] };
  }
}

function normalizeShiftRatingEntry(senderKey, value = {}) {
  const score = Number.isFinite(Number(value.score)) ? Number(value.score) : parseFatigueScore(value.answerText);
  return {
    id: normalizeText(value.id),
    senderKey,
    date: normalizeText(value.date),
    promptedAt: normalizeText(value.promptedAt),
    answeredAt: normalizeText(value.answeredAt),
    answerText: normalizeText(value.answerText),
    shiftText: normalizeText(value.text),
    score,
    fatigueBand: normalizeText(value.fatigueBand) || classifyFatigue(score),
    triggerType: normalizeText(value.triggerType),
    shiftKey: normalizeText(value.shiftKey),
    shiftKind: normalizeText(value.shiftKind),
    event: value.event && typeof value.event === "object" ? value.event : null,
  };
}

function parseDateOrNow(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
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
    hour12: false,
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function parseTimeToMinutes(value) {
  const match = normalizeText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hashText(value) {
  let hash = 5381;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(index);
    hash >>>= 0;
  }
  return hash.toString(16);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ShiftRatingService,
  classifyFatigue,
  findDueCompletedShift,
  hasPromptForShift,
  looksLikeShiftEnded,
  looksLikeFutureShiftPlan,
  looksLikeScore,
  parseFatigueScore,
  readShiftRatingForDate,
};
