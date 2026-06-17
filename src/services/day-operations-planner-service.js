const fs = require("fs");
const path = require("path");

const COURSE_PATTERN = /(weiterbildung|fortbildung|seminar|kurs|course|class|lecture|praxisanleitung|网课|课程|上课|培训|继续教育)/i;
const EARLY_SHIFT_PATTERN = /(frühdienst|fruehdienst|early\s*shift|早班)/i;
const LATE_SHIFT_PATTERN = /(spätdienst|spaetdienst|late\s*shift|晚班)/i;
const NIGHT_SHIFT_PATTERN = /(nachtdienst|nachtwache|night\s*shift|夜班)/i;
const WORK_PATTERN = /(dienst|shift|schicht|arbeit|上班|工作|值班)/i;

class DayOperationsPlannerService {
  constructor({ config, dailyState = null } = {}) {
    this.config = config || {};
    this.dailyState = dailyState;
    this.stateFile = this.config.dayOperationsPlanStateFile;
  }

  async plan({ date = "", now = new Date(), analysis = null } = {}) {
    if (this.config.dayOperationsPlannerEnabled === false) {
      return null;
    }
    const timeZone = this.timeZone();
    const local = localDateParts(now, timeZone);
    const targetDate = normalizeDate(date) || local.date;
    const dailyAnalysis = analysis || await this.analyze({ date: targetDate, now });
    if (!dailyAnalysis) {
      return null;
    }
    const plan = buildDayOperationsPlan({
      analysis: dailyAnalysis,
      now,
      date: targetDate,
      config: this.config,
    });
    this.savePlan(plan);
    return plan;
  }

  shouldDefer(plan, options = {}) {
    return shouldDeferForOperationsPlan(plan, options);
  }

  promptSummary(plan) {
    return summarizeOperationsPlanForPrompt(plan);
  }

  async analyze({ date, now }) {
    if (!this.dailyState || typeof this.dailyState.analyze !== "function") {
      return null;
    }
    try {
      return await this.dailyState.analyze({ date, now });
    } catch (error) {
      console.error(`[cyberboss] day operations planner daily state failed date=${date}: ${error.message}`);
      return null;
    }
  }

  savePlan(plan) {
    if (!this.stateFile || !plan) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const state = readLatestDayOperationsPlan(this.stateFile) || { plans: {} };
      const plans = state.plans && typeof state.plans === "object" ? state.plans : {};
      plans[plan.date] = plan;
      fs.writeFileSync(this.stateFile, `${JSON.stringify({ plans: prunePlans(plans, plan.date) }, null, 2)}\n`, "utf8");
    } catch (error) {
      console.error(`[cyberboss] day operations planner state write failed: ${error.message}`);
    }
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }
}

function buildDayOperationsPlan({ analysis, now = new Date(), date = "", config = {} } = {}) {
  const timeZone = analysis?.timeZone || config.timeZone || config.diaryTimeZone || "UTC";
  const local = localDateParts(now, timeZone);
  const targetDate = normalizeDate(date) || analysis?.date || local.date;
  const scheduleMode = normalizeText(analysis?.scheduleMode)
    || normalizeText(analysis?.temporalContext?.scheduleMode)
    || resolveScheduleMode(analysis?.signals || {});
  const scheduleEvents = Array.isArray(analysis?.temporalContext?.scheduleEventsToday)
    ? analysis.temporalContext.scheduleEventsToday
    : [];
  const fixedBlocks = scheduleEvents
    .map((event) => normalizeFixedBlock(event, targetDate))
    .filter(Boolean)
    .sort((left, right) => left.startMinutes - right.startMinutes);
  const doNotDisturbWindows = fixedBlocks.map((block) => ({
    id: `dnd:${block.id}`,
    label: block.label,
    reason: `${block.kind}_calendar_block`,
    start: block.start,
    end: block.end,
    startMinutes: block.startMinutes,
    endMinutes: block.endMinutes,
    source: "calendar",
  }));
  const recoveryWindows = buildRecoveryWindows({ fixedBlocks, scheduleMode, config });
  const priorityWindows = buildPriorityWindows({
    analysis,
    fixedBlocks,
    recoveryWindows,
    scheduleMode,
    config,
  });
  const contextQuestionWindow = buildContextQuestionWindow(analysis?.contextQuestionTiming);
  const openLevelA = (analysis?.levelA || []).filter((item) => !item.completed);
  const completedLevelA = (analysis?.levelA || []).filter((item) => item.completed);
  const currentPhase = evaluatePlanPhase({
    plan: {
      date: targetDate,
      timeZone,
      scheduleMode,
      doNotDisturbWindows,
      recoveryWindows,
      priorityWindows,
      contextQuestionWindow,
      levelA: {
        open: openLevelA,
        completed: completedLevelA,
      },
    },
    now,
  });
  const plan = {
    date: targetDate,
    timeZone,
    generatedAt: now.toISOString(),
    scheduleMode,
    dayType: scheduleMode,
    day_type: scheduleMode,
    summary: buildSummary({ scheduleMode, fixedBlocks, currentPhase, openLevelA }),
    fixedBlocks,
    doNotDisturbWindows,
    recoveryWindows,
    priorityWindows,
    contextQuestionWindow,
    levelA: {
      completed: completedLevelA.map(summarizeHabit),
      open: openLevelA.map(summarizeHabit),
    },
    recommendedMode: analysis?.recommendedMode || "standard",
    currentPhase,
  };
  return plan;
}

function evaluatePlanPhase({ plan, now = new Date() } = {}) {
  const timeZone = plan?.timeZone || "UTC";
  const local = localDateParts(now, timeZone);
  const nowMinutes = local.hour * 60 + local.minute;
  if (plan?.date && local.date !== plan.date) {
    return {
      kind: "out_of_date",
      reason: `plan_date_${plan.date}_local_date_${local.date}`,
      shouldSpeak: false,
      shouldDefer: false,
      recommendedAction: "refresh_plan",
    };
  }
  const dnd = findWindow(plan?.doNotDisturbWindows, nowMinutes);
  if (dnd) {
    return {
      kind: "do_not_disturb",
      reason: dnd.reason || "calendar_block",
      window: publicWindow(dnd),
      shouldSpeak: false,
      shouldDefer: true,
      recommendedAction: "stay_silent_until_block_ends",
    };
  }
  const recovery = findWindow(plan?.recoveryWindows, nowMinutes);
  if (recovery) {
    return {
      kind: "recovery",
      reason: recovery.reason || "recovery_buffer",
      window: publicWindow(recovery),
      shouldSpeak: false,
      shouldDefer: true,
      recommendedAction: "let_recovery_settle_before_priority_prompt",
    };
  }
  const priority = findWindow(plan?.priorityWindows, nowMinutes);
  const openLevelA = Array.isArray(plan?.levelA?.open) ? plan.levelA.open : [];
  if (priority) {
    return {
      kind: "priority_window",
      reason: priority.reason || "usable_priority_window",
      window: publicWindow(priority),
      shouldSpeak: openLevelA.length > 0,
      shouldDefer: false,
      recommendedAction: openLevelA.length > 0 ? "restore_priority_awareness" : "no_level_a_prompt_needed",
    };
  }
  if (plan?.contextQuestionWindow && containsMinute(plan.contextQuestionWindow, nowMinutes)) {
    return {
      kind: "context_question_window",
      reason: plan.contextQuestionWindow.reason || "daily_state_context_question",
      window: publicWindow(plan.contextQuestionWindow),
      shouldSpeak: true,
      shouldDefer: false,
      recommendedAction: "ask_one_missing_context_question_if_needed",
    };
  }
  return {
    kind: "open",
    reason: "no_fixed_block_or_protected_window_now",
    shouldSpeak: false,
    shouldDefer: false,
    recommendedAction: "speak_only_if_user_message_needs_reply",
  };
}

function shouldDeferForOperationsPlan(plan, { allowPriorityBoundary = false } = {}) {
  const phase = plan?.currentPhase;
  if (!phase?.shouldDefer) {
    return false;
  }
  if (allowPriorityBoundary && phase.kind === "recovery") {
    return false;
  }
  return true;
}

function getCanonicalDayType(plan) {
  return normalizeText(plan?.dayType)
    || normalizeText(plan?.day_type)
    || normalizeText(plan?.scheduleMode);
}

function summarizeOperationsPlanForPrompt(plan) {
  if (!plan) {
    return "";
  }
  const fixed = (plan.fixedBlocks || [])
    .slice(0, 4)
    .map((block) => `${block.label} ${block.start}-${block.end}`)
    .join("; ");
  const priority = (plan.priorityWindows || [])
    .slice(0, 3)
    .map((window) => `${window.label} ${window.start}-${window.end}`)
    .join("; ");
  const phase = plan.currentPhase
    ? `${plan.currentPhase.kind} (${plan.currentPhase.reason || "unknown"})`
    : "unknown";
  return [
    `mode=${getCanonicalDayType(plan) || "unknown"}`,
    fixed ? `fixed=${fixed}` : "fixed=none",
    priority ? `priority_windows=${priority}` : "priority_windows=none",
    `current_phase=${phase}`,
  ].join("; ");
}

function readLatestDayOperationsPlan(filePath) {
  const normalized = normalizeText(filePath);
  if (!normalized || !fs.existsSync(normalized)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(normalized, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readPlanForDate(filePath, date) {
  const state = readLatestDayOperationsPlan(filePath);
  const plans = state?.plans && typeof state.plans === "object" ? state.plans : {};
  return plans[date] || null;
}

function buildRecoveryWindows({ fixedBlocks, scheduleMode, config }) {
  const windows = [];
  const shiftRecovery = readPositiveInt(config.dayOperationsShiftRecoveryMinutes, 60);
  const courseRecovery = readPositiveInt(config.dayOperationsCourseRecoveryMinutes, 30);
  for (const block of fixedBlocks) {
    if (block.kind === "course") {
      windows.push(makeWindow({
        id: `recovery:${block.id}`,
        label: `Recovery after ${block.label}`,
        reason: "course_reentry_buffer",
        startMinutes: block.endMinutes,
        endMinutes: block.endMinutes + courseRecovery,
      }));
    } else if (["early_shift", "late_shift", "night_shift", "work"].includes(block.kind)) {
      const minutes = block.kind === "night_shift" ? Math.min(shiftRecovery, 45) : shiftRecovery;
      windows.push(makeWindow({
        id: `recovery:${block.id}`,
        label: `Recovery after ${block.label}`,
        reason: `${block.kind}_recovery_buffer`,
        startMinutes: block.endMinutes,
        endMinutes: block.endMinutes + minutes,
      }));
    }
  }
  if (!windows.length && scheduleMode === "night_shift") {
    windows.push(makeWindow({
      id: "recovery:night-shift-default",
      label: "Night-shift recovery",
      reason: "night_shift_recovery_default",
      startMinutes: 8 * 60,
      endMinutes: 15 * 60,
    }));
  }
  return mergeWindows(windows);
}

function buildPriorityWindows({ analysis, fixedBlocks, recoveryWindows, scheduleMode, config }) {
  const endHour = readHour(config.dayOperationsPriorityWindowEndHour, 21);
  const windows = [];
  const latestBlockEnd = fixedBlocks.reduce((max, block) => Math.max(max, block.endMinutes), 0);
  const latestRecoveryEnd = recoveryWindows.reduce((max, window) => Math.max(max, window.endMinutes), latestBlockEnd);
  const earliestFixedStart = fixedBlocks.reduce((min, block) => Math.min(min, block.startMinutes), 24 * 60);
  const dueAtMinutes = Number.isInteger(analysis?.priorityTiming?.dueAtMinutes)
    ? analysis.priorityTiming.dueAtMinutes
    : 20 * 60;

  if (scheduleMode === "off_day") {
    windows.push(makeWindow({ id: "priority:off-day-late-morning", label: "Off-day late morning", reason: "off_day_flexible_morning", startMinutes: 11 * 60, endMinutes: 13 * 60 }));
    windows.push(makeWindow({ id: "priority:off-day-afternoon", label: "Off-day afternoon", reason: "off_day_flexible_afternoon", startMinutes: 15 * 60, endMinutes: 18 * 60 }));
    windows.push(makeWindow({ id: "priority:off-day-evening", label: "Off-day evening", reason: "off_day_evening_guardian", startMinutes: 19 * 60 + 30, endMinutes: endHour * 60 }));
  } else if (scheduleMode === "late_shift") {
    const shiftStart = earliestFixedStart < 24 * 60 ? earliestFixedStart : 13 * 60;
    windows.push(makeWindow({ id: "priority:late-shift-before-work", label: "Late-shift before-work window", reason: "late_shift_morning_window", startMinutes: 10 * 60, endMinutes: Math.max(10 * 60, shiftStart - 60) }));
  } else if (scheduleMode === "night_shift") {
    const nightStart = findFirstBlockStart(fixedBlocks, "night_shift") ?? 21 * 60;
    const start = Math.max(10 * 60, Math.min(dueAtMinutes, nightStart - 180));
    windows.push(makeWindow({ id: "priority:night-shift-before-work", label: "Night-shift pre-shift window", reason: "night_shift_pre_shift_window", startMinutes: start, endMinutes: Math.max(start, nightStart - 60) }));
  } else if (scheduleMode === "course_day") {
    windows.push(makeWindow({ id: "priority:course-day-after-course", label: "After-course re-entry window", reason: "course_day_after_learning_window", startMinutes: Math.max(16 * 60, latestRecoveryEnd), endMinutes: endHour * 60 }));
  } else if (scheduleMode === "early_shift") {
    windows.push(makeWindow({ id: "priority:early-shift-after-work", label: "Early-shift after-work window", reason: "early_shift_after_work_window", startMinutes: Math.max(16 * 60, latestRecoveryEnd), endMinutes: endHour * 60 }));
  } else {
    windows.push(makeWindow({ id: "priority:normal-evening", label: "Normal evening window", reason: "normal_day_evening_window", startMinutes: 18 * 60, endMinutes: endHour * 60 }));
  }
  return mergeWindows(windows.filter((window) => window.endMinutes > window.startMinutes));
}

function buildContextQuestionWindow(contextQuestionTiming) {
  const start = parseClockMinutes(contextQuestionTiming?.dueAt);
  if (!Number.isInteger(start)) {
    return null;
  }
  return makeWindow({
    id: "context-question",
    label: "Daily state question window",
    reason: contextQuestionTiming?.reason || "daily_state_question",
    startMinutes: start,
    endMinutes: start + 90,
  });
}

function normalizeFixedBlock(event, targetDate = "") {
  const rawStartMinutes = parseClockMinutes(event?.start);
  const rawEndMinutes = parseClockMinutes(event?.end);
  if (!Number.isInteger(rawStartMinutes) || !Number.isInteger(rawEndMinutes)) {
    return null;
  }
  const startDate = normalizeDate(event?.startDate);
  const endDate = normalizeDate(event?.endDate);
  const spansIntoTarget = startDate && startDate < targetDate && (!endDate || endDate >= targetDate);
  const spansAfterTarget = endDate && endDate > targetDate && (!startDate || startDate <= targetDate);
  const startMinutes = spansIntoTarget ? 0 : rawStartMinutes;
  const text = `${event?.title || ""} ${event?.calendar || ""}`;
  const kind = classifyBlock(text);
  const endMinutes = spansAfterTarget || rawEndMinutes <= startMinutes ? 24 * 60 - 1 : rawEndMinutes;
  const label = normalizeText(event?.title) || "(untitled)";
  return {
    id: normalizeId(`${label}-${event?.start || ""}-${event?.end || ""}`),
    label,
    title: label,
    calendar: normalizeText(event?.calendar),
    kind,
    start: formatMinutes(startMinutes),
    end: formatMinutes(endMinutes),
    startMinutes,
    endMinutes,
  };
}

function classifyBlock(text) {
  if (COURSE_PATTERN.test(text)) return "course";
  if (NIGHT_SHIFT_PATTERN.test(text)) return "night_shift";
  if (EARLY_SHIFT_PATTERN.test(text)) return "early_shift";
  if (LATE_SHIFT_PATTERN.test(text)) return "late_shift";
  if (WORK_PATTERN.test(text)) return "work";
  return "commitment";
}

function findFirstBlockStart(blocks, kind) {
  const found = (blocks || []).filter((block) => block.kind === kind).sort((left, right) => left.startMinutes - right.startMinutes)[0];
  return found ? found.startMinutes : null;
}

function makeWindow({ id, label, reason, startMinutes, endMinutes, source = "planner" }) {
  const boundedStart = clampMinute(startMinutes);
  const boundedEnd = clampMinute(endMinutes);
  return {
    id,
    label,
    reason,
    source,
    start: formatMinutes(boundedStart),
    end: formatMinutes(boundedEnd),
    startMinutes: boundedStart,
    endMinutes: boundedEnd,
  };
}

function mergeWindows(windows) {
  return (windows || [])
    .filter((window) => window && window.endMinutes > window.startMinutes)
    .sort((left, right) => left.startMinutes - right.startMinutes);
}

function findWindow(windows, minute) {
  return (windows || []).find((window) => containsMinute(window, minute)) || null;
}

function containsMinute(window, minute) {
  return window
    && Number.isInteger(window.startMinutes)
    && Number.isInteger(window.endMinutes)
    && minute >= window.startMinutes
    && minute < window.endMinutes;
}

function publicWindow(window) {
  if (!window) {
    return null;
  }
  return {
    label: window.label,
    start: window.start,
    end: window.end,
    reason: window.reason,
  };
}

function buildSummary({ scheduleMode, fixedBlocks, currentPhase, openLevelA }) {
  const fixed = fixedBlocks.length
    ? `${fixedBlocks.length} fixed block${fixedBlocks.length > 1 ? "s" : ""}`
    : "no fixed calendar blocks";
  const open = openLevelA.length
    ? `open Level A: ${openLevelA.map((item) => item.label || item.id).join(", ")}`
    : "Level A complete or unknown";
  return `${scheduleMode || "unknown_day"} with ${fixed}; current phase ${currentPhase.kind}; ${open}`;
}

function summarizeHabit(item) {
  return {
    id: item.id,
    label: item.label,
    completed: Boolean(item.completed),
    estimatedMinutes: item.estimatedMinutes || 0,
  };
}

function resolveScheduleMode(signals = {}) {
  if (signals.hasNightShift) return "night_shift";
  if (signals.hasLateShift) return "late_shift";
  if (signals.hasEarlyShift) return "early_shift";
  if (signals.hasCourseDay) return "course_day";
  if (signals.hasOffDay) return "off_day";
  return "normal_day";
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

function formatMinutes(minutes) {
  const bounded = clampMinute(minutes);
  return `${String(Math.floor(bounded / 60)).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
}

function clampMinute(minutes) {
  const number = Number(minutes);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(24 * 60 - 1, Math.floor(number)));
}

function readHour(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 23 ? Math.floor(number) : fallback;
}

function readPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function prunePlans(plans, today = "") {
  if (!today) {
    return plans;
  }
  const cutoff = addDaysText(today, -14);
  return Object.fromEntries(Object.entries(plans || {}).filter(([date]) => date >= cutoff));
}

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeDate(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeId(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
}

module.exports = {
  DayOperationsPlannerService,
  buildDayOperationsPlan,
  evaluatePlanPhase,
  readLatestDayOperationsPlan,
  readPlanForDate,
  getCanonicalDayType,
  shouldDeferForOperationsPlan,
  summarizeOperationsPlanForPrompt,
};
