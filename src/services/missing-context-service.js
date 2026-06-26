const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");

const DEFAULT_CHECK_INTERVAL_MS = 300_000;
const DEFAULT_RESPONSE_WINDOW_MS = 16 * 60 * 60_000;

class MissingContextService {
  constructor({ config, dailyState = null, channelAdapter = null, sessionStore = null, currentState = null, proactiveIntervention = null } = {}) {
    this.config = config || {};
    this.dailyState = dailyState;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.currentState = currentState;
    this.proactiveIntervention = proactiveIntervention;
    this.stateFile = this.config.missingContextStateFile;
    this.lastCheckAtMs = 0;
  }

  async observeIncoming(normalized = {}) {
    if (this.config.missingContextEnabled === false) {
      return { handled: false };
    }
    const text = normalizeText(normalized.text);
    if (!text || !normalized.senderId || !normalized.contextToken) {
      return { handled: false };
    }
    const now = parseDateOrNow(normalized.receivedAt);
    const date = formatDate(now, this.timeZone());
    const senderKey = buildSenderKey(normalized);
    const state = this.loadState();
    const day = ensureDay(state, date);
    expireStaleQuestions(day, now, this.responseWindowMs());

    const question = latestOpenQuestion(day, senderKey);
    if (!question) {
      this.saveState(state);
      return { handled: false };
    }
    const answer = parseAnswer(text, question);
    if (!answer) {
      this.saveState(state);
      return { handled: false };
    }

    question.status = answer.status;
    question.answeredAt = now.toISOString();
    question.answerText = text;
    question.answerKey = answer.key;
    question.answerLabel = answer.label;
    question.value = answer.value;
    day.fields = day.fields || {};
    day.fields[question.field] = {
      field: question.field,
      value: answer.value,
      label: answer.label,
      answerKey: answer.key,
      answeredAt: now.toISOString(),
      sourceQuestionId: question.id,
      related: question.related || {},
    };
    day.updatedAt = now.toISOString();
    this.saveState(state);

    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      text: buildAck(question, answer),
    });
    return { handled: true, question, answer };
  }

  async check(account, now = new Date()) {
    if (this.config.missingContextEnabled === false || !this.dailyState || !this.channelAdapter) {
      return { prompted: [] };
    }
    const intervalMs = this.config.missingContextCheckIntervalMs || DEFAULT_CHECK_INTERVAL_MS;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { prompted: [] };
    }
    this.lastCheckAtMs = now.getTime();

    const busy = this.currentState?.isBusyNow?.({ now });
    if (busy?.busy) {
      return { prompted: [], deferred: busy.state };
    }

    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot || !target.contextToken) {
      return { prompted: [] };
    }

    const local = localDateParts(now, this.timeZone());

    const state = this.loadState();
    const day = ensureDay(state, local.date);
    expireStaleQuestions(day, now, this.responseWindowMs());
    if (hasOpenQuestion(day, target.senderKey)) {
      this.saveState(state);
      return { prompted: [] };
    }
    if (dailyPromptCount(day) >= this.dailyMaxQuestions()) {
      this.saveState(state);
      return { prompted: [] };
    }
    if (hasUnansweredShiftRating(this.config, target.senderKey)) {
      this.saveState(state);
      return { prompted: [] };
    }

    const analysis = await this.dailyState.analyze({ date: local.date, now });
    if (!isContextQuestionDue(analysis, local, this.config)) {
      this.saveState(state);
      return { prompted: [] };
    }
    const question = chooseQuestion({ day, analysis, now, config: this.config });
    if (!question) {
      this.saveState(state);
      return { prompted: [] };
    }

    const reservation = this.proactiveIntervention?.request?.({
      source: "missing_context",
      category: "reflection",
      priority: "normal",
      subject: question.field,
      accountId: account.accountId,
      senderId: target.senderId,
      provider: this.channelAdapter?.describe?.().id || "channel",
      now,
    });
    if (reservation && !reservation.allowed) {
      this.saveState(state);
      return { prompted: [], deferred: `proactive_${reservation.reason}` };
    }

    const prompted = {
      ...question,
      id: `missing-context-${crypto.randomUUID()}`,
      date: local.date,
      senderKey: target.senderKey,
      status: "prompted",
      promptedAt: now.toISOString(),
      answeredAt: "",
      answerText: "",
      answerKey: "",
      answerLabel: "",
      value: null,
    };
    day.questions = Array.isArray(day.questions) ? day.questions : [];
    day.questions.push(prompted);
    day.updatedAt = now.toISOString();
    this.saveState(state);

    await this.channelAdapter.sendText({
      userId: target.senderId,
      contextToken: target.contextToken,
      text: formatQuestion(prompted),
    });
    console.log(`[cyberboss] missing context prompted field=${prompted.field}`);
    return { prompted: [prompted] };
  }

  resolveTarget(account) {
    const contextTokens = typeof this.channelAdapter?.getKnownContextTokens === "function"
      ? this.channelAdapter.getKnownContextTokens()
      : {};
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      sessionStore: this.sessionStore,
      contextTokens,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: account.accountId,
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

  timeZone() {
    return this.config.diaryTimeZone || this.config.timeZone || "UTC";
  }

  dailyMaxQuestions() {
    const value = Number(this.config.missingContextDailyMaxQuestions);
    return Number.isFinite(value) && value > 0 ? Math.min(3, Math.floor(value)) : 3;
  }

  responseWindowMs() {
    const value = Number(this.config.missingContextResponseWindowMs);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_RESPONSE_WINDOW_MS;
  }

  loadState() {
    const filePath = normalizeText(this.stateFile);
    if (!filePath || !fs.existsSync(filePath)) {
      return { days: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? { days: parsed.days || {} } : { days: {} };
    } catch {
      return { days: {} };
    }
  }

  saveState(state) {
    const filePath = normalizeText(this.stateFile);
    if (!filePath) {
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(pruneState(state), null, 2)}\n`, "utf8");
  }
}

function chooseQuestion({ day, analysis }) {
  const fields = day.fields || {};
  const missingLevelA = (analysis?.levelA || []).filter((item) => !item.completed);
  if (
    missingLevelA.length
    && analysis?.priorityTiming?.isDue
    && !fields.reason_for_missing_level_a
    && !wasFieldAsked(day, "reason_for_missing_level_a")
  ) {
    return {
      field: "reason_for_missing_level_a",
      title: "Level A 未完成原因",
      question: `今天 ${missingLevelA.map((item) => item.label).join("、")} 还没有记录，主要卡在哪里？`,
      options: [
        option("1", "太累", "fatigue"),
        option("2", "没时间", "time"),
        option("3", "忘记", "forgot"),
        option("4", "情绪不好", "emotion"),
        option("5", "不想做", "resistance"),
        option("6", "其他", "other"),
      ],
      related: { missingLevelA: missingLevelA.map((item) => item.id) },
    };
  }

  if (!fields.recovery_status && needsRecoveryQuestion(analysis) && !wasFieldAsked(day, "recovery_status")) {
    return {
      field: "recovery_status",
      title: "恢复状态",
      question: "今天身体恢复状态更接近哪一种？",
      options: [
        option("1", "恢复中，但还累", "recovering_tired"),
        option("2", "明显睡眠不足", "sleep_debt"),
        option("3", "身体不舒服", "body_discomfort"),
        option("4", "精神还可以", "okay"),
        option("5", "不确定", "unknown"),
      ],
      related: { hasNightShift: Boolean(analysis?.signals?.hasNightShift) },
    };
  }

  if (!fields.energy_score && !wasFieldAsked(day, "energy_score")) {
    return {
      field: "energy_score",
      title: "今日能量",
      question: "今天整体能量大概在哪一档？",
      options: [
        option("A", "很低（0-2）", 1),
        option("B", "偏低（3-4）", 3.5),
        option("C", "中等（5-6）", 5.5),
        option("D", "不错（7-8）", 7.5),
        option("E", "很好（9-10）", 9.5),
      ],
      related: {},
    };
  }

  if (!fields.mood_score && !wasFieldAsked(day, "mood_score")) {
    return {
      field: "mood_score",
      title: "今日心情",
      question: "今天心情整体更接近哪一档？",
      options: [
        option("A", "很低（0-2）", 1),
        option("B", "偏低（3-4）", 3.5),
        option("C", "中等（5-6）", 5.5),
        option("D", "不错（7-8）", 7.5),
        option("E", "很好（9-10）", 9.5),
      ],
      related: {},
    };
  }

  return null;
}

function isContextQuestionDue(analysis, local, config = {}) {
  const timing = analysis?.contextQuestionTiming;
  if (timing && typeof timing === "object") {
    return Boolean(timing.isDue);
  }
  const fallbackHour = readHourConfig(config, "missingContextDefaultHour", readHourConfig(config, "missingContextFirstPromptHour", 20));
  const localMinutes = (Number(local.hour) || 0) * 60 + (Number(local.minute) || 0);
  return localMinutes >= fallbackHour * 60;
}

function readHourConfig(config, key, fallback) {
  const value = Number(config?.[key]);
  return Number.isFinite(value) && value >= 0 && value <= 23 ? Math.floor(value) : fallback;
}

function needsRecoveryQuestion(analysis) {
  const signals = analysis?.signals || {};
  // Early shift does not need a recovery question — recovery framing is for after night shifts
  if (signals.hasEarlyShift && !signals.hasNightShift) {
    return false;
  }
  return Boolean(signals.hasNightShift || signals.hasSleepOrRest || signals.lowEnergy || signals.periodOrBodyDiscomfort);
}

function option(key, label, value) {
  return { key, label, value };
}

function formatQuestion(question) {
  return [
    question.question,
    "",
    ...question.options.map((item) => `${item.key}. ${item.label}`),
    "",
    "你可以只回字母或数字。我只是补一条复盘需要的关键上下文，不展开问。",
  ].join("\n");
}

function parseAnswer(text, question) {
  const body = normalizeText(text);
  if (/^(跳过|不知道|不确定|unknown|skip)$/i.test(body)) {
    return { status: "unknown", key: "unknown", label: "unknown", value: "unknown" };
  }
  const match = body.match(/^(?:选)?\s*([A-Fa-f]|\d{1,2})(?:\s*[\u3002.、,，].*)?$/);
  if (!match) {
    return null;
  }
  const token = match[1].toUpperCase();
  const choice = (question.options || []).find((item) => item.key === token);
  if (!choice) {
    return null;
  }
  return {
    status: "answered",
    key: choice.key,
    label: choice.label,
    value: choice.value,
  };
}

function buildAck(question, answer) {
  if (answer.status === "unknown") {
    return "好，这条先记 unknown，不追问你。";
  }
  return `记下了：${question.title} = ${answer.label}。`;
}

function ensureDay(state, date) {
  state.days = state.days || {};
  state.days[date] = state.days[date] || {
    date,
    questions: [],
    fields: {},
    createdAt: new Date().toISOString(),
    updatedAt: "",
  };
  state.days[date].questions = Array.isArray(state.days[date].questions) ? state.days[date].questions : [];
  state.days[date].fields = state.days[date].fields && typeof state.days[date].fields === "object" ? state.days[date].fields : {};
  return state.days[date];
}

function latestOpenQuestion(day, senderKey) {
  return (day.questions || [])
    .filter((item) => item.senderKey === senderKey && item.status === "prompted")
    .sort((left, right) => Date.parse(right.promptedAt) - Date.parse(left.promptedAt))[0] || null;
}

function hasOpenQuestion(day, senderKey) {
  return Boolean(latestOpenQuestion(day, senderKey));
}

function wasFieldAsked(day, field) {
  return (day.questions || []).some((item) => item.field === field && ["prompted", "answered", "unknown"].includes(item.status));
}

function dailyPromptCount(day) {
  return (day.questions || []).filter((item) => item.status !== "expired").length;
}

function expireStaleQuestions(day, now, responseWindowMs) {
  for (const question of day.questions || []) {
    if (question.status !== "prompted") {
      continue;
    }
    const promptedMs = Date.parse(question.promptedAt || "");
    if (Number.isFinite(promptedMs) && now.getTime() - promptedMs > responseWindowMs) {
      question.status = "unknown";
      question.answeredAt = now.toISOString();
      question.answerKey = "unknown";
      question.answerLabel = "unknown";
      question.value = "unknown";
    }
  }
}

function hasUnansweredShiftRating(config, senderKey) {
  const filePath = normalizeText(config.shiftRatingStateFile);
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const prompt = parsed?.lastPromptBySender?.[senderKey];
    if (prompt?.promptedAt && !prompt?.answeredAt) {
      return true;
    }
    return (Array.isArray(parsed?.entries) ? parsed.entries : [])
      .some((entry) => entry?.senderKey === senderKey && entry?.promptedAt && !entry?.answeredAt);
  } catch {
    return false;
  }
}

function pruneState(state) {
  const cutoff = Date.now() - 45 * 24 * 60 * 60_000;
  const days = {};
  for (const [date, day] of Object.entries(state.days || {})) {
    if (Date.parse(`${date}T12:00:00Z`) >= cutoff) {
      days[date] = day;
    }
  }
  return { days };
}

function readMissingContextState(filePath, date) {
  const normalized = normalizeText(filePath);
  if (!normalized || !fs.existsSync(normalized)) {
    return { fields: {}, questions: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(normalized, "utf8"));
    const day = parsed?.days?.[date];
    return {
      fields: day?.fields && typeof day.fields === "object" ? day.fields : {},
      questions: Array.isArray(day?.questions) ? day.questions : [],
    };
  } catch {
    return { fields: {}, questions: [] };
  }
}

function buildSenderKey(normalized = {}) {
  return `${normalizeText(normalized.provider) || "channel"}:${normalizeText(normalized.senderId)}`;
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
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function formatDate(date, timeZone) {
  return localDateParts(date, timeZone).date;
}

function parseDateOrNow(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  MissingContextService,
  chooseQuestion,
  parseAnswer,
  readMissingContextState,
};
