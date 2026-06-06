const fs = require("fs");
const path = require("path");

const SHIFT_END_PATTERN = /(下班了|下班啦|下班\b|交班|夜班结束|班结束|下夜班|off\s*work|shift\s*ended|feierabend)/i;
const EXPLICIT_OFF_WORK_TIME_PATTERN = /\b\d{1,2}[:：]\d{2}\s*(?:下班|交班)/;
const FUTURE_MARKER_PATTERN = /(明天|后天|今晚|待会|等下|一会儿|之后|到时候|准备|计划|打算|要去|会在|will|tomorrow|later)/i;
const SCORE_PATTERN = /(?:^|[^\d])(?:10|[0-9](?:\.[0-9])?)\s*分(?:吧|左右|多|了|，|。|,|\.|\s|$)|(?:^|[^\d])(?:10|[0-9](?:\.[0-9])?)\s*\/\s*10(?:\D|$)|(?:疲惫|疲劳|累|能量|状态|打分|分数).{0,12}(?:10|[0-9](?:\.[0-9])?)/;
const DEFAULT_COOLDOWN_MS = 8 * 60 * 60_000;

class ShiftRatingService {
  constructor({ config, channelAdapter }) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
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

    if (looksLikeScore(text)) {
      markAnswered(state, senderKey, date, text, now);
      this.saveState(state);
      return { handled: false };
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
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      text: prompt,
    });
    state.lastPromptBySender = state.lastPromptBySender || {};
    state.lastPromptBySender[senderKey] = {
      date,
      text,
      promptedAt: now.toISOString(),
      answeredAt: "",
      answerText: "",
    };
    this.saveState(state);
    return { handled: true, prompt };
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
      return { lastPromptBySender: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : { lastPromptBySender: {} };
    } catch {
      return { lastPromptBySender: {} };
    }
  }

  saveState(state) {
    const filePath = normalizeText(this.config.shiftRatingStateFile);
    if (!filePath) {
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state || { lastPromptBySender: {} }, null, 2)}\n`, "utf8");
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

function wasRecentlyPrompted(state, senderKey, now, cooldownMs) {
  const previous = state?.lastPromptBySender?.[senderKey];
  const promptedMs = Date.parse(previous?.promptedAt || "");
  return Number.isFinite(promptedMs) && now.getTime() - promptedMs < cooldownMs && !previous?.answeredAt;
}

function markAnswered(state, senderKey, date, text, now) {
  const previous = state?.lastPromptBySender?.[senderKey];
  if (!previous) {
    return;
  }
  state.lastPromptBySender[senderKey] = {
    ...previous,
    date: previous.date || date,
    answeredAt: now.toISOString(),
    answerText: text,
  };
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ShiftRatingService,
  looksLikeShiftEnded,
  looksLikeFutureShiftPlan,
  looksLikeScore,
};
