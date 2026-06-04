const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");

const DEFAULT_LEVEL_A = [
  habit("sport", "Sport", ["sport", "运动", "workout", "training", "健身", "跑步", "瑜伽", "拉伸", "锻炼"], ["exercise.workout", "exercise.sport"], "未来的健康、能量、身体自主性和独立生活能力", 60),
  habit("english", "Englisch", ["englisch", "english", "英语"], [], "未来学习、国际文献阅读和更广阔的知识世界", 25),
  habit("german", "Deutsch", ["deutsch", "german", "德语"], [], "专业沟通、教学、护理文书、职业发展和未来学术工作", 30),
];

const DEFAULT_LEVEL_B = [
  habit("praxisanleitung", "Praxisanleitung", ["praxisanleitung", "praxisleiter"], [], "专业教学能力、护理实践成长和未来教育者身份", 30),
  habit("wundmanagement", "Wundmanagement", ["wundmanagement", "伤口管理"], [], "临床专业能力和护理职业发展", 30),
  habit("python", "Python", ["python"], [], "研究能力、数据思维和未来护理科学工作", 30),
];

const DEFAULT_LEVEL_C = [
  habit("pflegewissenschaft", "Pflegewissenschaft", ["pflegewissenschaft", "护理科学"], [], "成为护理科学家并持续建立学术基础", 30),
  habit("literature-reading", "Literature Reading", ["literature reading", "文献阅读", "论文阅读"], [], "终身学习、国际视野和研究能力", 30),
  habit("nursing-digest", "Nursing Digest", ["nursing digest"], [], "持续积累护理知识和长期专业判断", 30),
  habit("forschung", "Forschung", ["forschung", "research", "研究"], [], "未来研究者、护理科学家和教授身份", 30),
];

class CriticalHabitsMonitor {
  constructor({ config, timeline, channelAdapter, sessionStore, systemMessageQueue }) {
    this.config = config || {};
    this.timeline = timeline;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.systemMessageQueue = systemMessageQueue;
    this.stateFile = this.config.criticalHabitsStateFile;
    this.lastCheckAtMs = 0;
  }

  async check(account) {
    if (!this.config.criticalHabitsEnabled || !this.timeline || !this.systemMessageQueue) {
      return { queued: [] };
    }
    const now = new Date();
    const intervalMs = this.config.criticalHabitsCheckIntervalMs || 300_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { queued: [] };
    }
    this.lastCheckAtMs = now.getTime();

    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot) {
      return { queued: [] };
    }

    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const local = localDateParts(now, timeZone);
    const state = this.loadState();
    const queued = [];

    if (local.hour >= this.config.criticalHabitsLevelAHour) {
      const events = await this.readEventsForDates([local.date]);
      for (const item of this.config.criticalHabitsLevelA) {
        const key = `A:${local.date}:${item.id}`;
        if (!state.sent[key] && !events.some((event) => matchesHabit(event, item))) {
          queued.push(this.enqueueHabitMessage({ account, target, level: "A", item, key, now }));
          state.sent[key] = now.toISOString();
        }
      }
    }

    if (
      local.hour >= this.config.criticalHabitsLevelBHour
      && this.config.criticalHabitsLevelBWeekdays.includes(local.weekday)
    ) {
      const dates = trailingDates(local.date, 7);
      const events = await this.readEventsForDates(dates);
      for (const item of this.config.criticalHabitsLevelB) {
        const key = `B:${local.isoWeek}:${item.id}`;
        if (!state.sent[key] && !events.some((event) => matchesHabit(event, item))) {
          queued.push(this.enqueueHabitMessage({ account, target, level: "B", item, key, now }));
          state.sent[key] = now.toISOString();
        }
      }
    }

    state.sent = pruneSentState(state.sent, local.date);
    this.saveState(state);
    return { queued };
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

  async readEventsForDates(dates) {
    const events = [];
    for (const date of dates) {
      try {
        const result = await this.timeline.read({ date });
        events.push(...(Array.isArray(result?.data?.events) ? result.data.events : []));
      } catch (error) {
        console.error(`[cyberboss] critical habits timeline read failed date=${date}: ${error.message}`);
      }
    }
    return events;
  }

  enqueueHabitMessage({ account, target, level, item, key, now }) {
    const text = level === "A"
      ? `Critical Habits Monitor: 今天还没有记录 ${item.label}。它对 ${this.config.userName} 的长期意义是：${item.meaning || "她已经选择的长期成长方向"}。请以温和而坚定的 Long-Term Values Guardian + Reality-Aware Guardian 方式提醒：先连接意义和她正在成为的自己，再判断这是需要最小一步回来，还是她真的需要休息。不要责备或施压，但也不要只安慰到让目标消失。明确给出三个选择：现在做一个最小版本、延期、或今天有意识地休息/放弃。强调 Always Return：重点不是完美连续，而是之后怎么回来。`
      : `Critical Habits Monitor: 过去 7 天还没有记录 ${item.label} 的进展。它支持的长期意义是：${item.meaning || "她已经选择的长期成长方向"}。请温和而坚定地帮助 ${this.config.userName} 重新连接这个方向，重点是防止长期目标被遗忘，不要责备或施压。可以建议一个很小的回来入口，也允许延期或本周休息/放弃。强调 Always Return，而不是完美连续。`;
    const message = this.systemMessageQueue.enqueue({
      id: `critical-habit:${key}:${crypto.randomUUID()}`,
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text,
      createdAt: now.toISOString(),
    });
    console.log(`[cyberboss] critical habit queued level=${level} habit=${item.id}`);
    return message;
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
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function habit(id, label, keywords, categoryPrefixes, meaning = "", estimatedMinutes = 30) {
  return { id, label, keywords, categoryPrefixes, meaning, estimatedMinutes };
}

function matchesHabit(event, item) {
  const tags = Array.isArray(event?.tags) ? event.tags.join(" ") : "";
  const categoryFields = [event?.categoryId, event?.subcategoryId, event?.eventNodeId]
    .map((value) => String(value || "").toLowerCase())
    .filter(Boolean);
  const text = `${event?.title || ""} ${event?.note || ""} ${event?.description || ""} ${tags}`.toLowerCase();
  return item.keywords.some((keyword) => text.includes(keyword.toLowerCase()))
    || item.categoryPrefixes.some((prefix) => categoryFields.some((field) => field.startsWith(prefix.toLowerCase())));
}

function localDateParts(date, timeZone) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  const dateText = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date: dateText,
    hour: Number(parts.hour),
    weekday: weekdayNumber(parts.weekday),
    isoWeek: isoWeekKey(dateText),
  };
}

function weekdayNumber(shortName) {
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[shortName] || 0;
}

function isoWeekKey(dateText) {
  const date = new Date(`${dateText}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function trailingDates(dateText, count) {
  const date = new Date(`${dateText}T12:00:00Z`);
  const dates = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const current = new Date(date);
    current.setUTCDate(current.getUTCDate() - index);
    dates.push(current.toISOString().slice(0, 10));
  }
  return dates;
}

function pruneSentState(sent, currentDate) {
  const cutoff = new Date(`${currentDate}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 45);
  return Object.fromEntries(Object.entries(sent).filter(([, value]) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= cutoff.getTime();
  }));
}

module.exports = {
  CriticalHabitsMonitor,
  DEFAULT_LEVEL_A,
  DEFAULT_LEVEL_B,
  DEFAULT_LEVEL_C,
  matchesHabit,
};
