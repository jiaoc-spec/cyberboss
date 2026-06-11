const fs = require("fs");
const path = require("path");

const FOCUS_REMINDER_PREFIX = "[Focus Protection completion check]";
const DEFAULT_FOCUS_MINUTES = 25;

const NATURAL_FOCUS_PATTERNS = [
  /^(?:开始|我要|我现在|现在)\s*(?:学|学习|练|做)?\s*(?<task>英语|英文|德语|运动|健身|python|Python|学习|阅读|写作|复习|工作|收拾)?\s*(?<minutes>\d{1,3})\s*分钟/i,
  /^(?:开始|我要|我现在|现在)\s*(?:学|学习|练|做)?\s*(?<task>英语|英文|德语|运动|健身|python|Python|学习|阅读|写作|复习|工作|收拾)\s*(?<minutes>\d{1,3})?\s*分钟?/i,
  /^(?:我要|我现在|现在)?\s*(?:专注|focus)\s*(?:到|until)?\s*(?<until>\d{1,2}[:：]\d{2})\s*(?<task>.*)?$/i,
  /^(?:不要打扰我|别打扰我|先别打扰我)\s*(?:到|until)\s*(?<until>\d{1,2}[:：]\d{2})\s*(?<task>.*)?$/i,
];

const COMPLETION_PATTERN = /(完成|做完|学完|练完|结束|搞定|done|finished|completed)/i;
const CANCEL_PATTERN = /(取消\s*focus|focus\s*cancel|退出\s*focus|结束\s*focus|停止\s*focus)/i;

class FocusProtectionService {
  constructor({ config, reminder = null, timeline = null, channelAdapter = null, sessionStore = null } = {}) {
    this.config = config || {};
    this.reminder = reminder;
    this.timeline = timeline;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.stateFile = this.config.focusProtectionStateFile;
  }

  // One-touch start for playbook digit replies: resolves the preferred sender
  // itself so the model only has to pass task and minutes.
  async startQuick({ task = "", minutes = 10, now = new Date(), sourceText = "" } = {}) {
    const normalizedTask = String(task || "").trim();
    if (!normalizedTask) {
      throw new Error("focus_start: task is required.");
    }
    const safeMinutes = Number.isFinite(Number(minutes)) && Number(minutes) >= 3
      ? Math.min(Math.round(Number(minutes)), 180)
      : 10;
    const provider = this.channelAdapter?.describe?.().id || "telegram";
    const contextTokens = typeof this.channelAdapter?.getKnownContextTokens === "function"
      ? this.channelAdapter.getKnownContextTokens()
      : {};
    const account = this.channelAdapter?.resolveAccount?.() || { accountId: "" };
    const { resolvePreferredSenderId } = require("../core/default-targets");
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      sessionStore: this.sessionStore,
      contextTokens,
    });
    if (!senderId) {
      throw new Error("focus_start: cannot resolve the chat user.");
    }
    const endAt = new Date(now.getTime() + safeMinutes * 60_000);
    const session = await this.start({
      senderKey: `${provider}:${senderId}`,
      task: normalizedTask,
      startAt: now,
      endAt,
      sourceText: sourceText || `playbook quick start ${safeMinutes}m`,
      normalized: { provider, senderId },
    });
    return { session, minutes: safeMinutes };
  }

  async observeIncoming(normalized = {}) {
    if (this.config.focusProtectionEnabled === false) {
      return { handled: false };
    }
    const text = normalizeText(normalized.text);
    if (!text) {
      return { handled: false };
    }
    const receivedAt = parseDateOrNow(normalized.receivedAt);
    const senderKey = buildSenderKey(normalized);

    if (CANCEL_PATTERN.test(text)) {
      const result = this.cancel({ senderKey, now: receivedAt, reason: text });
      return { handled: result.cancelled, reply: result.cancelled ? "好，Focus 先取消。你不用补解释，等会儿我们从现在重新接。" : "" };
    }

    const active = this.getActive({ senderKey, now: receivedAt });
    if (active && COMPLETION_PATTERN.test(text) && matchesFocusTask(text, active.task)) {
      const result = await this.complete({ senderKey, now: receivedAt, evidence: text });
      return {
        handled: result.completed,
        reply: result.completed ? `好，${result.session.task} 收住了。我帮你把这段专注留在时间线上。` : "",
      };
    }

    const parsed = parseNaturalFocus(text, receivedAt, this.timeZone());
    if (!parsed) {
      return { handled: false };
    }
    const session = await this.start({
      senderKey,
      task: parsed.task,
      startAt: receivedAt,
      endAt: parsed.endAt,
      sourceText: text,
      normalized,
    });
    return {
      handled: true,
      session,
      reply: buildFocusStartReply(session, this.timeZone()),
    };
  }

  async startFromCommand(args = "", normalized = {}) {
    const now = parseDateOrNow(normalized.receivedAt);
    const senderKey = buildSenderKey(normalized);
    const parsed = parseFocusCommand(args, now, this.timeZone());
    if (parsed.action === "cancel") {
      const result = this.cancel({ senderKey, now, reason: args });
      return result.cancelled ? result : { cancelled: false, reply: "现在没有 active Focus。你是自由的。" };
    }
    if (!parsed.task && !parsed.endAt) {
      return { error: "Usage: /focus 25 Englisch · /focus until 18:00 Deutsch · /focus cancel" };
    }
    const session = await this.start({
      senderKey,
      task: parsed.task || "Focus",
      startAt: now,
      endAt: parsed.endAt,
      sourceText: `/focus ${args}`.trim(),
      normalized,
    });
    return { session, reply: buildFocusStartReply(session, this.timeZone()) };
  }

  async start({ senderKey, task, startAt, endAt, sourceText = "", normalized = {} }) {
    const state = this.loadState();
    const nowIso = startAt.toISOString();
    const session = {
      id: `focus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderKey,
      status: "active",
      task: normalizeTask(task) || "Focus",
      startAt: nowIso,
      endAt: endAt.toISOString(),
      sourceText: normalizeText(sourceText),
      completedAt: "",
      cancelledAt: "",
      evidence: "",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    state.sessions = closeActiveSessions(state.sessions, senderKey, startAt, "cancelled", "replaced by a newer focus session");
    state.sessions.push(session);
    this.saveState(state);
    await this.createCompletionReminder(session, normalized);
    return session;
  }

  async complete({ senderKey, now = new Date(), evidence = "" } = {}) {
    const state = this.loadState();
    const session = findLatestOpenSession(state.sessions, senderKey, now);
    if (!session) {
      return { completed: false };
    }
    session.status = "completed";
    session.completedAt = now.toISOString();
    session.evidence = normalizeText(evidence);
    session.updatedAt = now.toISOString();
    this.saveState(state);
    await this.writeFocusTimeline(session, now);
    return { completed: true, session };
  }

  cancel({ senderKey, now = new Date(), reason = "" } = {}) {
    const state = this.loadState();
    const session = findLatestOpenSession(state.sessions, senderKey, now);
    if (!session) {
      return { cancelled: false };
    }
    session.status = "cancelled";
    session.cancelledAt = now.toISOString();
    session.evidence = normalizeText(reason);
    session.updatedAt = now.toISOString();
    this.saveState(state);
    return { cancelled: true, session };
  }

  getActive({ senderKey = "", now = new Date() } = {}) {
    if (this.config.focusProtectionEnabled === false) {
      return null;
    }
    const state = this.loadState();
    return getActiveFocusSession(state, { senderKey, now });
  }

  isProtected({ senderId = "", provider = "", now = new Date() } = {}) {
    const senderKey = provider && senderId ? `${provider}:${senderId}` : "";
    const active = this.getActive({ senderKey, now });
    return active ? { protected: true, session: active } : { protected: false, session: null };
  }

  shouldDelayReminder(reminder, now = new Date()) {
    if (!reminder?.senderId) {
      return { delay: false };
    }
    if (isFocusCompletionReminder(reminder)) {
      return { delay: false };
    }
    const tokens = [reminder.senderId, `telegram:${reminder.senderId}`, `weixin:${reminder.senderId}`];
    for (const senderKey of tokens) {
      const active = this.getActive({ senderKey, now });
      if (active) {
        return { delay: true, session: active };
      }
    }
    return { delay: false };
  }

  async createCompletionReminder(session, normalized = {}) {
    if (!this.reminder || typeof this.reminder.create !== "function") {
      return null;
    }
    const text = [
      FOCUS_REMINDER_PREFIX,
      `Task: ${session.task}`,
      "DELIVERY REQUIRED. Focus Mode ended. Ask only whether this focus task was completed. Do not add other reminders, Level A checks, or unrelated review. Keep it short, warm, and concrete.",
    ].join("\n");
    try {
      return await this.reminder.create({
        dueAt: session.endAt,
        text,
        userId: normalized.senderId,
      }, {
        senderId: normalized.senderId,
      });
    } catch (error) {
      console.error(`[cyberboss] focus completion reminder failed: ${error.message}`);
      return null;
    }
  }

  async writeFocusTimeline(session, completedAt) {
    if (!this.timeline || typeof this.timeline.write !== "function") {
      return;
    }
    const start = parseDateOrNow(session.startAt);
    const end = parseDateOrNow(session.completedAt || completedAt);
    if (end <= start) {
      return;
    }
    const classification = classifyFocusTask(session.task);
    const date = formatDate(start, this.timeZone());
    await this.timeline.write({
      date,
      mode: "merge",
      events: [{
        id: session.id,
        title: `Focus: ${session.task}`,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        categoryId: classification.categoryId,
        subcategoryId: classification.subcategoryId,
        eventNodeId: classification.eventNodeId,
        note: `Focus session completed. Evidence: ${session.evidence || "unknown"}`,
        tags: ["focus", "focus-protection"],
      }],
    });
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }

  loadState() {
    const filePath = normalizeText(this.stateFile);
    if (!filePath || !fs.existsSync(filePath)) {
      return { sessions: [] };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return { sessions: Array.isArray(parsed?.sessions) ? parsed.sessions.map(normalizeSession).filter(Boolean) : [] };
    } catch {
      return { sessions: [] };
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

function parseNaturalFocus(text, now, timeZone) {
  const body = normalizeText(text);
  for (const pattern of NATURAL_FOCUS_PATTERNS) {
    const match = body.match(pattern);
    if (!match) continue;
    const groups = match.groups || {};
    const task = normalizeTask(groups.task) || inferTask(body) || "Focus";
    const minutes = parsePositiveInt(groups.minutes);
    const endAt = groups.until
      ? localClockTimeToDate(groups.until, now, timeZone)
      : new Date(now.getTime() + (minutes || DEFAULT_FOCUS_MINUTES) * 60_000);
    if (endAt <= now) continue;
    return { task, endAt };
  }
  return null;
}

function parseFocusCommand(args, now, timeZone) {
  const body = normalizeText(args);
  if (!body) {
    return {};
  }
  if (/^(cancel|取消|停止|结束)$/i.test(body)) {
    return { action: "cancel" };
  }
  const untilMatch = body.match(/^until\s+(\d{1,2}[:：]\d{2})\s*(.*)$/i) || body.match(/^到\s*(\d{1,2}[:：]\d{2})\s*(.*)$/i);
  if (untilMatch) {
    return {
      task: normalizeTask(untilMatch[2]) || "Focus",
      endAt: localClockTimeToDate(untilMatch[1], now, timeZone),
    };
  }
  const minuteMatch = body.match(/^(\d{1,3})\s*(?:m|min|分钟)?\s*(.*)$/i);
  if (minuteMatch) {
    const minutes = parsePositiveInt(minuteMatch[1]) || DEFAULT_FOCUS_MINUTES;
    return {
      task: normalizeTask(minuteMatch[2]) || "Focus",
      endAt: new Date(now.getTime() + minutes * 60_000),
    };
  }
  return {};
}

function getActiveFocusSession(state, { senderKey = "", now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  return (state.sessions || [])
    .filter((session) => session.status === "active")
    .filter((session) => !senderKey || session.senderKey === senderKey || session.senderKey.endsWith(`:${senderKey}`))
    .filter((session) => Date.parse(session.startAt) <= nowMs && nowMs < Date.parse(session.endAt))
    .sort((left, right) => Date.parse(right.startAt) - Date.parse(left.startAt))[0] || null;
}

function findLatestOpenSession(sessions = [], senderKey = "", now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  const windowMs = 2 * 60 * 60_000;
  return sessions
    .filter((session) => session.senderKey === senderKey)
    .filter((session) => session.status === "active" || session.status === "expired")
    .filter((session) => Date.parse(session.startAt) <= nowMs && nowMs <= Date.parse(session.endAt) + windowMs)
    .sort((left, right) => Date.parse(right.startAt) - Date.parse(left.startAt))[0] || null;
}

function closeActiveSessions(sessions = [], senderKey, now, status, reason) {
  return sessions.map((session) => {
    if (session.senderKey === senderKey && session.status === "active" && Date.parse(session.endAt) > now.getTime()) {
      return {
        ...session,
        status,
        cancelledAt: status === "cancelled" ? now.toISOString() : session.cancelledAt,
        evidence: reason,
        updatedAt: now.toISOString(),
      };
    }
    return session;
  });
}

function normalizeSession(value) {
  if (!value || typeof value !== "object") return null;
  const task = normalizeTask(value.task);
  const senderKey = normalizeText(value.senderKey);
  const startAt = normalizeIso(value.startAt);
  const endAt = normalizeIso(value.endAt);
  if (!task || !senderKey || !startAt || !endAt) return null;
  const status = ["active", "completed", "expired", "cancelled"].includes(value.status) ? value.status : "active";
  return {
    id: normalizeText(value.id) || `focus-${Date.parse(startAt) || Date.now()}`,
    senderKey,
    status,
    task,
    startAt,
    endAt,
    sourceText: normalizeText(value.sourceText),
    completedAt: normalizeText(value.completedAt),
    cancelledAt: normalizeText(value.cancelledAt),
    evidence: normalizeText(value.evidence),
    createdAt: normalizeText(value.createdAt) || startAt,
    updatedAt: normalizeText(value.updatedAt) || startAt,
  };
}

function pruneState(state) {
  const cutoff = Date.now() - 45 * 24 * 60 * 60_000;
  return {
    sessions: (state.sessions || []).map(normalizeSession).filter(Boolean)
      .filter((session) => Date.parse(session.startAt) >= cutoff),
  };
}

function buildSenderKey(normalized = {}) {
  return `${normalizeText(normalized.provider) || "channel"}:${normalizeText(normalized.senderId) || "default"}`;
}

function isFocusCompletionReminder(reminder = {}) {
  return normalizeText(reminder.text).startsWith(FOCUS_REMINDER_PREFIX);
}

function buildFocusStartReply(session, timeZone) {
  return `好，${session.task} Focus 开始。到 ${formatLocalTime(session.endAt, timeZone)} 前我先替你挡掉不急的打扰。到点我只问你这一件：做完了吗。`;
}

function matchesFocusTask(text, task) {
  const body = normalizeText(text).toLowerCase();
  const normalizedTask = normalizeTask(task).toLowerCase();
  return !normalizedTask || normalizedTask === "focus" || body.includes(normalizedTask.toLowerCase()) || COMPLETION_PATTERN.test(body);
}

function normalizeTask(value) {
  const task = normalizeText(value).replace(/^(到|until|学|学习|练|做)\s*/i, "").trim();
  if (!task) return "";
  if (/英文|英语/i.test(task)) return "Englisch";
  if (/德语/i.test(task)) return "Deutsch";
  if (/运动|健身|sport|workout|training/i.test(task)) return "Sport";
  return task;
}

function inferTask(text) {
  if (/不要打扰|别打扰|专注|focus/i.test(normalizeText(text))) {
    return "";
  }
  return normalizeTask(text);
}

function classifyFocusTask(task) {
  const normalized = normalizeTask(task).toLowerCase();
  if (/englisch|english|deutsch|german|英语|德语/.test(normalized)) {
    return { categoryId: "study", subcategoryId: "study.language", eventNodeId: "evt.study_language" };
  }
  if (/sport|运动|健身|workout|training/.test(normalized)) {
    return { categoryId: "exercise", subcategoryId: "exercise.workout", eventNodeId: "evt.exercise_workout" };
  }
  if (/python|code|编程/.test(normalized)) {
    return { categoryId: "work", subcategoryId: "work.coding", eventNodeId: "evt.focus_coding" };
  }
  return { categoryId: "work", subcategoryId: "work.deep_focus", eventNodeId: "evt.focus_session" };
}

function localClockTimeToDate(clock, now, timeZone) {
  const match = normalizeText(clock).match(/^(\d{1,2})[:：](\d{2})$/);
  if (!match) return new Date(now.getTime() + DEFAULT_FOCUS_MINUTES * 60_000);
  const parts = localDateTimeParts(now, timeZone);
  const localIso = `${parts.date}T${String(Number(match[1])).padStart(2, "0")}:${match[2]}:00`;
  let date = localDateTimeToDate(localIso, timeZone);
  if (date <= now) {
    date = new Date(date.getTime() + 24 * 60 * 60_000);
  }
  return date;
}

function localDateTimeToDate(value, timeZone) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return new Date(value);
  const desiredUtcMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  let candidateMs = desiredUtcMs;
  for (let index = 0; index < 2; index += 1) {
    const parts = localDateTimeParts(new Date(candidateMs), timeZone);
    const representedUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidateMs += desiredUtcMs - representedUtcMs;
  }
  return new Date(candidateMs);
}

function localDateTimeParts(date, timeZone) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function parseDateOrNow(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatLocalTime(value, timeZone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function normalizeIso(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  FocusProtectionService,
  FOCUS_REMINDER_PREFIX,
  getActiveFocusSession,
  isFocusCompletionReminder,
  parseFocusCommand,
  parseNaturalFocus,
};
