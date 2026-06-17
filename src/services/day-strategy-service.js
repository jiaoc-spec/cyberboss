const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");

const WORK_SHIFT_PATTERN = /(frühdienst|fruehdienst|spätdienst|spaetdienst|nachtdienst|nachtwache|early\s*shift|late\s*shift|night\s*shift|早班|晚班|夜班)/i;
const EARLY_SHIFT_PATTERN = /(frühdienst|fruehdienst|early\s*shift|早班)/i;
const COURSE_DAY_PATTERN = /(weiterbildung|fortbildung|seminar|kurs|course|class|lecture|praxisanleitung|网课|课程|上课|培训|继续教育)/i;

class DayStrategyService {
  constructor({
    config,
    dailyState = null,
    calendar = null,
    campaign = null,
    channelAdapter = null,
    sessionStore = null,
    systemMessageQueue = null,
    focusProtection = null,
    currentState = null,
  } = {}) {
    this.config = config || {};
    this.dailyState = dailyState;
    this.calendar = calendar;
    this.campaign = campaign;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.systemMessageQueue = systemMessageQueue;
    this.focusProtection = focusProtection;
    this.currentState = currentState;
    this.stateFile = this.config.dayStrategyStateFile;
    this.lastCheckAtMs = 0;
  }

  async check(account, now = new Date()) {
    if (this.config.dayStrategyEnabled === false || !this.dailyState || !this.systemMessageQueue) {
      return { queued: [] };
    }
    const intervalMs = this.config.dayStrategyCheckIntervalMs || 300_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { queued: [] };
    }
    this.lastCheckAtMs = now.getTime();

    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot) {
      return { queued: [] };
    }
    if (this.systemMessageQueue.hasPendingForAccount?.(account.accountId)) {
      return { queued: [], deferred: "pending_system_message" };
    }
    const focus = this.focusProtection?.isProtected?.({
      senderId: target.senderId,
      provider: this.channelAdapter?.describe?.().id || "",
      now,
    });
    if (focus?.protected) {
      return { queued: [], deferred: "focus" };
    }
    const busy = this.currentState?.isBusyNow?.({ now });
    if (busy?.busy) {
      return { queued: [], deferred: busy.state };
    }
    const current = this.currentState?.current?.({ now });
    if (isQuietCurrentState(current, this.config)) {
      return { queued: [], deferred: current.state };
    }

    const timeZone = this.timeZone();
    const local = localDateParts(now, timeZone);
    const analysis = await this.dailyState.analyze({ date: local.date, now });
    if (analysis?.temporalContext?.currentEvent) {
      return { queued: [], deferred: "calendar_event" };
    }

    const state = this.loadState();
    const campaignStatus = await this.readCampaignStatus(local.date);
    const tomorrow = await this.readTomorrowContext(local.date);
    const strategy = chooseStrategyCheckpoint({
      analysis,
      campaignStatus,
      tomorrow,
      local,
      current,
      config: this.config,
    });
    if (!strategy) {
      this.saveState(state, local.date);
      return { queued: [] };
    }
    const key = `${local.date}:${strategy.id}`;
    if (state.sent[key]) {
      this.saveState(state, local.date);
      return { queued: [] };
    }

    const text = buildDayStrategyTrigger({
      strategy,
      analysis,
      campaignStatus,
      tomorrow,
      config: this.config,
    });
    const message = this.systemMessageQueue.enqueue({
      id: `day-strategy:${key}:${crypto.randomUUID()}`,
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text,
      createdAt: now.toISOString(),
    });
    state.sent[key] = now.toISOString();
    this.saveState(state, local.date);
    console.log(`[cyberboss] day strategy queued date=${local.date} strategy=${strategy.id}`);
    return { queued: [message], strategy };
  }

  async readCampaignStatus(date) {
    if (!this.campaign || typeof this.campaign.status !== "function") {
      return { date, activeCampaigns: [], upcomingDeadlines: [] };
    }
    try {
      return await this.campaign.status({ date });
    } catch (error) {
      console.error(`[cyberboss] day strategy campaign read failed date=${date}: ${error.message}`);
      return { date, activeCampaigns: [], upcomingDeadlines: [] };
    }
  }

  async readTomorrowContext(date) {
    if (!this.calendar || typeof this.calendar.read !== "function") {
      return { date: addDaysText(date, 1), morningEvents: [], workEvents: [] };
    }
    const tomorrow = addDaysText(date, 1);
    try {
      const result = await this.calendar.read({
        start: `${tomorrow}T00:00:00`,
        end: `${tomorrow}T12:00:00`,
        includeNotes: false,
      });
      const events = Array.isArray(result?.events) ? result.events : [];
      const morningEvents = events
        .filter((event) => !event?.isAllDay)
        .map((event) => summarizeCalendarEvent(event, this.timeZone()))
        .filter(Boolean)
        .sort((left, right) => left.start.localeCompare(right.start));
      return {
        date: tomorrow,
        morningEvents,
        workEvents: morningEvents.filter((event) => WORK_SHIFT_PATTERN.test(event.title)),
      };
    } catch (error) {
      console.error(`[cyberboss] day strategy tomorrow calendar read failed date=${tomorrow}: ${error.message}`);
      return { date: tomorrow, morningEvents: [], workEvents: [] };
    }
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
    return { senderId, workspaceRoot };
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return { sent: parsed?.sent && typeof parsed.sent === "object" ? parsed.sent : {} };
    } catch {
      return { sent: {} };
    }
  }

  saveState(state, today = "") {
    if (!this.stateFile) {
      return;
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify({ sent: pruneSent(state.sent, today) }, null, 2)}\n`, "utf8");
  }
}

function chooseStrategyCheckpoint({ analysis, campaignStatus, tomorrow, local, current, config = {} }) {
  const mode = resolveScheduleMode(analysis?.signals || {});
  const missingLevelA = (analysis?.levelA || []).filter((item) => !item.completed);
  const hasUpcomingDeadline = (campaignStatus?.upcomingDeadlines || []).some((item) => item.daysLeft <= 14);
  if (!missingLevelA.length && !hasUpcomingDeadline) {
    return null;
  }
  const localMinutes = local.hour * 60 + (local.minute || 0);
  const due = (hourKey, minuteKey, fallbackHour, fallbackMinute = 0) =>
    readHourConfig(config, hourKey, fallbackHour) * 60 + readMinuteConfig(config, minuteKey, fallbackMinute);

  if (mode === "off_day") {
    const firstDue = due("dayStrategyOffDayFirstHour", "dayStrategyOffDayFirstMinute", 11, 0);
    if (localMinutes >= firstDue) {
      return {
        id: "off_day_open_window",
        mode,
        reason: "Apple Calendar indicates a free/off day.",
        tone: "freedom_with_structure",
      };
    }
    return null;
  }

  if (mode === "course_day") {
    const courseDue = resolveCourseDayDueMinutes(analysis, config);
    if (localMinutes >= courseDue) {
      return {
        id: "course_day_after_learning_window",
        mode,
        reason: "Apple Calendar shows a Weiterbildung/course day, so this is an after-course window rather than an off day.",
        tone: "after_course_reentry",
      };
    }
    return null;
  }

  if (mode === "late_shift") {
    const morningDue = due("dayStrategyLateShiftHour", "dayStrategyLateShiftMinute", 10, 30);
    if (localMinutes >= morningDue) {
      return {
        id: "late_shift_morning_window",
        mode,
        reason: "Late shift days have a useful morning window before work.",
        tone: "use_morning_window",
      };
    }
    return null;
  }

  if (mode === "early_shift") {
    const afterWorkDue = due("dayStrategyEarlyShiftHour", "dayStrategyEarlyShiftMinute", 16, 30);
    if (localMinutes >= afterWorkDue) {
      return {
        id: "early_shift_after_work_window",
        mode,
        reason: "Early shift likely leaves an evening window, with recovery needs.",
        tone: "after_work_recovery_first",
      };
    }
    return null;
  }

  if (mode === "night_shift") {
    const preShiftDue = Math.max(0, (analysis?.priorityTiming?.dueAtMinutes ?? (16 * 60)) - 60);
    if (localMinutes >= preShiftDue) {
      return {
        id: "night_shift_pre_shift_strategy",
        mode,
        reason: "Night shift later today makes the pre-shift window important.",
        tone: "pre_shift_realistic",
      };
    }
    return null;
  }

  const tomorrowEarly = (tomorrow?.workEvents || []).some((event) => EARLY_SHIFT_PATTERN.test(event.title));
  if (tomorrowEarly) {
    const eveningDue = due("dayStrategyBeforeEarlyShiftHour", "dayStrategyBeforeEarlyShiftMinute", 17, 30);
    if (localMinutes >= eveningDue) {
      return {
        id: "before_tomorrow_early_shift",
        mode,
        reason: "Tomorrow morning has an early shift, so tonight needs protection.",
        tone: "protect_evening_sleep",
      };
    }
  }
  if (current?.state === "woke_up") {
    return null;
  }
  return null;
}

function buildDayStrategyTrigger({ strategy, analysis, campaignStatus, tomorrow, config = {} }) {
  const userName = String(config.userName || "Jane").trim();
  const levelA = analysis?.levelA || [];
  const completed = levelA.filter((item) => item.completed).map((item) => item.label);
  const missing = levelA.filter((item) => !item.completed).map((item) => `${item.label} (${item.estimatedMinutes || "?"}m)`);
  const todaySchedule = (analysis?.temporalContext?.scheduleEventsToday || [])
    .slice(0, 5)
    .map((event) => `${event.title} ${event.start}-${event.end}`);
  const deadlines = (campaignStatus?.upcomingDeadlines || [])
    .filter((item) => item.daysLeft <= 14)
    .slice(0, 3)
    .map((item) => `${item.label} in ${item.daysLeft}d${item.habitId ? ` -> ${item.habitId}` : ""}`);
  const tomorrowWork = (tomorrow?.workEvents || []).slice(0, 3).map((event) => `${event.title} ${event.start}-${event.end}`);
  return [
    "Day Strategy Assistant: DELIVERY REQUIRED.",
    `Strategy checkpoint: ${strategy.id}.`,
    `Reason: ${strategy.reason}`,
    `Schedule mode: ${strategy.mode}.`,
    `Local day state: ${analysis?.temporalContext?.localNow || analysis?.generatedAt || "unknown"}.`,
    `Level A completed: ${completed.length ? completed.join(", ") : "none recorded"}.`,
    `Level A still open: ${missing.length ? missing.join(", ") : "none"}.`,
    todaySchedule.length ? `Today schedule context: ${todaySchedule.join("; ")}.` : "Today schedule context: none known.",
    deadlines.length ? `Upcoming campaign/deadline context: ${deadlines.join("; ")}.` : "Upcoming campaign/deadline context: none known.",
    tomorrowWork.length ? `Tomorrow morning work context: ${tomorrowWork.join("; ")}.` : "Tomorrow morning work context: none known.",
    "This is not a random check-in and not a scolding. It is the Personal Executive Assistant layer deciding that today's schedule has a useful window.",
    "Use the Be-Do-Have frame internally: first name the identity Jane is protecting, then suggest the smallest action that gives that identity evidence today.",
    "Identity Ledger: health/fitness, language ability, nursing scientist/professor/teacher/ANP/researcher, and dancer/body-expression identity.",
    `Send one short, natural, warm message to ${userName}. Do not mention backend, strategy ids, calendar parsing, or tools.`,
    "If this is an off day, explicitly recognize that today has more flexible time than a workday and gently suggest using one good window for a chosen long-term value.",
    "If this is a course_day, explicitly recognize that today has Weiterbildung/course commitments and use an after-course re-entry tone. Do not call it an off day.",
    "If Level A still open is not none, mention every open Level A label once before offering options. Do not omit Sport when Sport is still open; Sport may be framed as a 5-10 minute minimum version.",
    "Do not assign a rigid order. Do not say she failed. Do not ask what she is doing. Offer one realistic first block or two small options, and keep the tone intimate, grounded, and not novelistic.",
    "If tomorrow has an early shift, protect the evening and sleep: suggest doing the smallest important thing earlier rather than dragging it late.",
    "Return send_message, not silent.",
  ].join("\n");
}

function resolveScheduleMode(signals = {}) {
  if (signals.hasNightShift) return "night_shift";
  if (signals.hasLateShift) return "late_shift";
  if (signals.hasEarlyShift) return "early_shift";
  if (signals.hasCourseDay) return "course_day";
  if (signals.hasOffDay) return "off_day";
  return "normal_day";
}

function resolveCourseDayDueMinutes(analysis, config = {}) {
  const fallback = readHourConfig(config, "dayStrategyCourseDayAfterHour", 16) * 60
    + readMinuteConfig(config, "dayStrategyCourseDayAfterMinute", 0);
  const grace = readPositiveIntConfig(config, "dayStrategyCourseDayGraceMinutes", 30);
  const scheduleEvents = analysis?.temporalContext?.scheduleEventsToday || [];
  const courseEndMinutes = scheduleEvents
    .filter((event) => COURSE_DAY_PATTERN.test(`${event.title || ""} ${event.calendar || ""}`))
    .map((event) => parseClockMinutes(event.end))
    .filter(Number.isInteger);
  if (!courseEndMinutes.length) {
    return fallback;
  }
  const latestCourseEnd = Math.max(...courseEndMinutes);
  return Math.min(20 * 60, Math.max(fallback, latestCourseEnd + grace));
}

function isQuietCurrentState(current, config = {}) {
  if (!current?.fresh) {
    return false;
  }
  if (current.state === "going_to_sleep") {
    return true;
  }
  if (current.state === "woke_up") {
    const graceMinutes = Number.isInteger(config.dayStrategyWakeGraceMinutes)
      ? config.dayStrategyWakeGraceMinutes
      : 120;
    return current.ageMinutes < graceMinutes;
  }
  return false;
}

function summarizeCalendarEvent(event, timeZone) {
  const start = parseDate(event?.start);
  const end = parseDate(event?.end);
  if (!start || !end) return null;
  return {
    title: normalizeText(event.title) || "(untitled)",
    calendar: normalizeText(event.calendar),
    start: formatLocalTime(start, timeZone),
    end: formatLocalTime(end, timeZone),
  };
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

function formatLocalTime(date, timeZone) {
  const parts = localDateParts(date, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
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

function readHourConfig(config, key, fallback) {
  const value = Number(config?.[key]);
  return Number.isFinite(value) && value >= 0 && value <= 23 ? Math.floor(value) : fallback;
}

function readMinuteConfig(config, key, fallback) {
  const value = Number(config?.[key]);
  return Number.isFinite(value) && value >= 0 && value <= 59 ? Math.floor(value) : fallback;
}

function readPositiveIntConfig(config, key, fallback) {
  const value = Number(config?.[key]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function parseClockMinutes(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function pruneSent(sent = {}, today = "") {
  if (!today) {
    return sent;
  }
  const cutoff = addDaysText(today, -21);
  const result = {};
  for (const [key, value] of Object.entries(sent)) {
    const date = key.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoff) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DayStrategyService,
  chooseStrategyCheckpoint,
  buildDayStrategyTrigger,
};
