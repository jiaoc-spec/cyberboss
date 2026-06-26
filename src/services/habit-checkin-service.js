const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { getCanonicalDayType } = require("./day-operations-planner-service");
const { TRACKED_HABITS } = require("./obsidian-tracker-sync-service");

const HABIT_GROUPS = [
  {
    title: "Level A / 地基",
    names: ["Sport", "英语发音", "英语影子跟读", "德语语法", "德语影子跟读", "德语表达"],
  },
  {
    title: "身体 / 塑形 / 舞蹈",
    names: ["冥想", "骨盆", "足弓", "健身", "基本功", "成品舞", "有氧操", "美容灯"],
  },
  {
    title: "长期成长",
    names: ["看书", "Praxisanleitung", "Wundmanagement", "Python", "Nursing Digest"],
  },
];

class HabitCheckinService {
  constructor({
    config,
    dailyState = null,
    dayOperationsPlanner = null,
    channelAdapter = null,
    sessionStore = null,
  } = {}) {
    this.config = config || {};
    this.dailyState = dailyState;
    this.dayOperationsPlanner = dayOperationsPlanner;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.stateFile = this.config.habitCheckinStateFile;
    this.lastCheckAtMs = 0;
  }

  async check(account, now = new Date()) {
    if (this.config.habitCheckinEnabled === false || typeof this.channelAdapter?.sendText !== "function") {
      return { sent: false, skipped: "disabled" };
    }
    const intervalMs = this.config.habitCheckinCheckIntervalMs || 300_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { sent: false, skipped: "interval" };
    }
    this.lastCheckAtMs = now.getTime();

    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot) {
      return { sent: false, skipped: "no_target" };
    }

    const timeZone = this.timeZone();
    const local = localDateParts(now, timeZone);
    const state = this.loadState();
    if (state.sent?.[local.date]) {
      return { sent: false, skipped: "already_sent" };
    }

    const context = await this.resolveDayContext({ date: local.date, now });
    const dueMinutes = resolveHabitCheckinDueMinutes(context.dayType, this.config);
    const nowMinutes = local.hour * 60 + local.minute;
    if (nowMinutes < dueMinutes) {
      return {
        sent: false,
        skipped: "not_due",
        dueAt: formatMinutes(dueMinutes),
        dayType: context.dayType,
      };
    }

    const text = buildHabitCheckinMessage({
      date: local.date,
      dayType: context.dayType,
      dueAt: formatMinutes(dueMinutes),
    });
    await this.channelAdapter.sendText({
      userId: target.senderId,
      text,
      contextToken: this.channelAdapter.getKnownContextTokens?.()[target.senderId] || target.senderId,
    });
    state.sent[local.date] = {
      sentAt: now.toISOString(),
      dueAt: formatMinutes(dueMinutes),
      dayType: context.dayType,
      scheduleSource: context.source,
    };
    this.saveState(state);
    console.log(`[cyberboss] habit check-in sent date=${local.date} dayType=${context.dayType}`);
    return { sent: true, date: local.date, dayType: context.dayType, dueAt: formatMinutes(dueMinutes) };
  }

  async resolveDayContext({ date, now }) {
    let analysis = null;
    if (this.dailyState && typeof this.dailyState.analyze === "function") {
      try {
        analysis = await this.dailyState.analyze({ date, now });
      } catch (error) {
        console.error(`[cyberboss] habit check-in daily state failed date=${date}: ${error.message}`);
      }
    }
    if (this.dayOperationsPlanner && typeof this.dayOperationsPlanner.plan === "function") {
      try {
        const plan = await this.dayOperationsPlanner.plan({ date, now, analysis });
        const canonical = getCanonicalDayType(plan);
        if (canonical) {
          return { dayType: canonical, source: "day_operations_plan", plan, analysis };
        }
      } catch (error) {
        console.error(`[cyberboss] habit check-in operations plan failed date=${date}: ${error.message}`);
      }
    }
    return {
      dayType: normalizeDayType(analysis?.scheduleMode || analysis?.temporalContext?.scheduleMode),
      source: analysis ? "daily_state" : "default",
      analysis,
    };
  }

  resolveTarget(account = {}) {
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      sessionStore: this.sessionStore,
      contextTokens: this.channelAdapter?.getKnownContextTokens?.(),
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: account.accountId,
      senderId,
      sessionStore: this.sessionStore,
    });
    return { senderId, workspaceRoot };
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return { sent: parsed?.sent && typeof parsed.sent === "object" ? parsed.sent : {} };
    } catch {
      return { sent: {} };
    }
  }

  saveState(state) {
    if (!this.stateFile) {
      return;
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }
}

function resolveHabitCheckinDueMinutes(dayType, config = {}) {
  const hourKey = {
    early_shift: "habitCheckinEarlyShiftHour",
    late_shift: "habitCheckinLateShiftHour",
    night_shift: "habitCheckinNightShiftHour",
    off_day: "habitCheckinOffDayHour",
    course_day: "habitCheckinDefaultHour",
    normal_day: "habitCheckinDefaultHour",
  }[normalizeDayType(dayType)] || "habitCheckinDefaultHour";
  return clampHour(config[hourKey], defaultHourForKey(hourKey)) * 60;
}

function buildHabitCheckinMessage({ date, dayType, dueAt } = {}) {
  const lines = [
    `Jane，今天的 habit check-in 清单在这里。`,
    `日程判断：${formatDayType(dayType)}；今天 ${dueAt} 后发这一份就够。`,
    "",
    "这不是说今天全部都要做完，只是把你想守住的轨道放到眼前。等今天的现实展开以后，挑最合适的一两个入口就好。",
    "",
  ];
  const knownNames = new Set(TRACKED_HABITS.map((habit) => habit.name));
  for (const group of HABIT_GROUPS) {
    const items = group.names.filter((name) => knownNames.has(name));
    if (!items.length) {
      continue;
    }
    lines.push(group.title);
    for (const name of items) {
      lines.push(`□ ${name}`);
    }
    lines.push("");
  }
  lines.push("先看见它们，就已经比让它们消失在脑子后台里更好了。");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeDayType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "normal_day";
  if (/early|früh|frueh|早班/.test(text)) return "early_shift";
  if (/late|spät|spaet|晚班/.test(text)) return "late_shift";
  if (/night|nacht|夜班/.test(text)) return "night_shift";
  if (/off|free|rest|休息|frei/.test(text)) return "off_day";
  if (/course|class|weiterbildung|fortbildung|kurs|seminar|课程|培训/.test(text)) return "course_day";
  return text;
}

function formatDayType(dayType) {
  return {
    early_shift: "早班",
    late_shift: "晚班",
    night_shift: "夜班",
    off_day: "休息日",
    course_day: "Weiterbildung / 课程日",
    normal_day: "普通日",
  }[normalizeDayType(dayType)] || normalizeDayType(dayType);
}

function defaultHourForKey(key) {
  return {
    habitCheckinEarlyShiftHour: 5,
    habitCheckinLateShiftHour: 7,
    habitCheckinNightShiftHour: 17,
    habitCheckinOffDayHour: 7,
    habitCheckinDefaultHour: 7,
  }[key] ?? 7;
}

function clampHour(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 23 ? Math.floor(number) : fallback;
}

function formatMinutes(minutes) {
  const bounded = Math.max(0, Math.min(24 * 60 - 1, Number(minutes) || 0));
  return `${String(Math.floor(bounded / 60)).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
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
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  const hour = Number(parts.hour || 0);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: hour === 24 ? 0 : hour,
    minute: Number(parts.minute || 0),
  };
}

module.exports = {
  HabitCheckinService,
  buildHabitCheckinMessage,
  resolveHabitCheckinDueMinutes,
};
