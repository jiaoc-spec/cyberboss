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

const PATTERN_CONTEXT_RULES = [
  { signal: "hasNightShift", domains: ["night-shift"], tags: ["night shift", "night-shift", "夜班"] },
  { signal: "highAfterShiftFatigue", domains: ["energy"], tags: ["fatigue", "energy", "疲惫", "level-a"] },
  { signal: "lowEnergy", domains: ["energy"], tags: ["fatigue", "energy", "low-energy"] },
  { signal: "periodOrBodyDiscomfort", domains: ["health"], tags: ["menstrual", "period", "生理期", "body"] },
];

class CriticalHabitsMonitor {
  constructor({ config, timeline, channelAdapter, sessionStore, systemMessageQueue, dailyState, focusProtection, patternLedger, currentState, campaign }) {
    this.config = config || {};
    this.timeline = timeline;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.systemMessageQueue = systemMessageQueue;
    this.dailyState = dailyState;
    this.focusProtection = focusProtection;
    this.patternLedger = patternLedger;
    this.currentState = currentState;
    this.campaign = campaign;
    this.stateFile = this.config.criticalHabitsStateFile;
    this.lastCheckAtMs = 0;
  }

  async check(account, now = new Date()) {
    if (!this.config.criticalHabitsEnabled || !this.timeline || !this.systemMessageQueue) {
      return { queued: [] };
    }
    const intervalMs = this.config.criticalHabitsCheckIntervalMs || 300_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { queued: [] };
    }
    this.lastCheckAtMs = now.getTime();

    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot) {
      return { queued: [] };
    }
    const focus = this.focusProtection?.isProtected?.({
      senderId: target.senderId,
      provider: this.channelAdapter?.describe?.().id || "",
      now,
    });
    if (focus?.protected) {
      return { queued: [] };
    }
    const busy = this.currentState?.isBusyNow?.({ now });
    if (busy?.busy) {
      return { queued: [], deferred: busy.state };
    }
    const current = this.currentState?.current?.({ now });
    if (isQuietCurrentState(current, this.config)) {
      return { queued: [], deferred: current.state };
    }

    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const local = localDateParts(now, timeZone);
    const state = this.loadState();
    const queued = [];

    const todayState = await this.analyzeToday({ date: local.date, now });
    if (isCalendarBusyNow(todayState)) {
      return { queued: [], deferred: "calendar_event" };
    }
    const guardianDue = local.hour >= this.config.criticalHabitsLevelAHour
      || todayState?.priorityTiming?.isDue === true;
    const softMiddayDue = !hasDayStrategySentToday(this.config.dayStrategyStateFile, local.date)
      && isLevelASoftMiddayDue({ local, config: this.config, todayState, current });
    const levelADue = guardianDue || softMiddayDue;
    const promptKind = softMiddayDue && !guardianDue ? "midday" : "guardian";

    if (levelADue) {
      const events = await this.readEventsForDates([local.date]);
      const missing = [];
      for (const item of this.resolveLevelAItems(local.date)) {
        const key = `${promptKind === "midday" ? "A_MIDDAY" : "A"}:${local.date}:${item.id}`;
        const dailyStateHabit = todayState?.levelA?.find((habitState) => habitState.id === item.id);
        const completed = dailyStateHabit?.completed || events.some((event) => matchesHabit(event, item));
        if (!state.sent[key] && !completed) {
          missing.push({ item, key });
        }
      }
      if (missing.length) {
        queued.push(await this.deliverLevelAMessage({ account, target, missing, now, dailyState: todayState, promptKind }));
        if (promptKind !== "midday") {
          this.recordPatternEvidence({ dailyState: todayState, missing, now });
        }
        for (const { key } of missing) {
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

  async analyzeToday({ date, now }) {
    if (!this.dailyState || typeof this.dailyState.analyze !== "function") {
      return null;
    }
    try {
      return await this.dailyState.analyze({ date, now });
    } catch (error) {
      console.error(`[cyberboss] critical habits daily state failed date=${date}: ${error.message}`);
      return null;
    }
  }

  // Level A plus any Level B/C habit temporarily boosted by a near campaign
  // deadline (e.g. an exam in 10 days promotes that subject to daily guardian).
  resolveLevelAItems(date) {
    const base = Array.isArray(this.config.criticalHabitsLevelA) ? this.config.criticalHabitsLevelA : [];
    if (!this.campaign || typeof this.campaign.boostedHabitIds !== "function") {
      return base;
    }
    const boostedIds = this.campaign.boostedHabitIds(date);
    if (!boostedIds.length) {
      return base;
    }
    const pool = [
      ...(Array.isArray(this.config.criticalHabitsLevelB) ? this.config.criticalHabitsLevelB : []),
      ...(Array.isArray(this.config.criticalHabitsLevelC) ? this.config.criticalHabitsLevelC : []),
    ];
    const baseIds = new Set(base.map((item) => item.id));
    const boosted = pool.filter((item) => boostedIds.includes(item.id) && !baseIds.has(item.id));
    if (boosted.length) {
      console.log(`[cyberboss] campaign boost active habits=${boosted.map((item) => item.id).join(",")}`);
    }
    return [...base, ...boosted];
  }

  collectSupportStrategies(dailyState, limit = 2) {
    if (!this.patternLedger || typeof this.patternLedger.read !== "function") {
      return [];
    }
    const signals = dailyState?.signals || {};
    const contextDomains = new Set();
    const contextTags = new Set();
    for (const rule of PATTERN_CONTEXT_RULES) {
      if (signals[rule.signal]) {
        rule.domains.forEach((domain) => contextDomains.add(domain));
        rule.tags.forEach((tag) => contextTags.add(tag.toLowerCase()));
      }
    }
    if (dailyState?.priorityTiming?.reason === "night_shift_recovery") {
      contextDomains.add("night-shift");
    }
    if (!contextDomains.size && !contextTags.size) {
      return [];
    }
    try {
      const ledger = this.patternLedger.read({});
      return (ledger.patterns || [])
        .filter((pattern) => ["active", "confirmed", "hypothesis"].includes(pattern.status)
          && pattern.supportStrategy
          && (pattern.status !== "hypothesis" || pattern.confidence >= 0.4)
          && (contextDomains.has(pattern.domain)
            || (pattern.tags || []).some((tag) => contextTags.has(String(tag).toLowerCase()))))
        .slice(0, limit)
        .map((pattern) => ({ id: pattern.id, title: pattern.title, supportStrategy: pattern.supportStrategy }));
    } catch (error) {
      console.error(`[cyberboss] critical habits pattern lookup failed: ${error.message}`);
      return [];
    }
  }

  recordPatternEvidence({ dailyState, missing, now }) {
    if (!this.patternLedger || typeof this.patternLedger.recordDailyStateEvidence !== "function") {
      return;
    }
    try {
      this.patternLedger.recordDailyStateEvidence({
        dailyState,
        missingLevelA: missing.map(({ item }) => item),
        observedAt: now,
      });
    } catch (error) {
      console.error(`[cyberboss] critical habits pattern evidence failed: ${error.message}`);
    }
  }

  enqueueHabitMessage({ account, target, level, item, key, now }) {
    const text = level === "A"
      ? `Critical Habits Monitor: DELIVERY REQUIRED. 今天还没有记录 ${item.label}。它对 ${this.config.userName} 的长期意义是：${item.meaning || "她已经选择的长期成长方向"}。请以温和而坚定的 Long-Term Values Guardian + Reality-Aware Guardian 方式提醒：先连接意义和她正在成为的自己，再判断这是需要最小一步回来，还是她真的需要休息。不要责备或施压，但也不要只安慰到让目标消失。明确给出三个选择：现在做一个最小版本、延期、或今天有意识地休息/放弃。强调 Always Return：重点不是完美连续，而是之后怎么回来。Return send_message, not silent.`
      : `Critical Habits Monitor: DELIVERY REQUIRED. 过去 7 天还没有记录 ${item.label} 的进展。它支持的长期意义是：${item.meaning || "她已经选择的长期成长方向"}。请温和而坚定地帮助 ${this.config.userName} 重新连接这个方向，重点是防止长期目标被遗忘，不要责备或施压。可以建议一个很小的回来入口，也允许延期或本周休息/放弃。强调 Always Return，而不是完美连续。Return send_message, not silent.`;
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

  async deliverLevelAMessage({ account, target, missing, now, dailyState, promptKind = "guardian" }) {
    const items = missing.map(({ item }) => item);
    const supportStrategies = this.collectSupportStrategies(dailyState);
    const text = buildLevelADirectMessage(items, dailyState, supportStrategies, { promptKind });
    if (typeof this.channelAdapter?.sendText === "function") {
      try {
        await this.channelAdapter.sendText({
          userId: target.senderId,
          text,
          contextToken: this.channelAdapter.getKnownContextTokens?.()[target.senderId] || target.senderId,
        });
        console.log(`[cyberboss] critical habit sent level=A habits=${items.map((item) => item.id).join(",")}`);
        return {
          id: `critical-habit-direct:${missing.map(({ key }) => key).join("+")}`,
          accountId: account.accountId,
          senderId: target.senderId,
          workspaceRoot: target.workspaceRoot,
          text,
          createdAt: now.toISOString(),
          direct: true,
        };
      } catch (error) {
        console.error(`[cyberboss] critical habit direct send failed: ${error.message}`);
      }
    }
    return this.enqueueLevelAMessage({ account, target, missing, now, supportStrategies, promptKind });
  }

  enqueueLevelAMessage({ account, target, missing, now, supportStrategies = [], promptKind = "guardian" }) {
    const items = missing.map(({ item }) => item);
    const text = [
      `Critical Habits Monitor: DELIVERY REQUIRED. Level A ${promptKind === "midday" ? "midday soft rhythm check" : "daily guardian trigger"}.`,
      `Today still has no recorded Level A activity for: ${items.map((item) => item.label).join(", ")}.`,
      "These are not ordinary tasks. They are the foundation habits Jane already chose for her future self.",
      ...items.map((item) => `${item.label}: ${item.meaning || "她已经选择的长期成长方向"}.`),
      ...(supportStrategies.length
        ? [
          "Pattern Ledger support strategies that match today's context (use them to shape the suggestion, do not quote them verbatim):",
          ...supportStrategies.map((entry) => `- [${entry.id}] ${entry.title}: ${entry.supportStrategy}`),
        ]
        : []),
      promptKind === "midday"
        ? "Return send_message, not silent. Send one concise, natural, warm-but-grounded message that restores priority awareness without treating this as a failure. This is a rhythm check, not a scolding."
        : "Return send_message, not silent. Send one concise, natural, warm-but-grounded message that restores priority awareness without guilt.",
      "Do not supervise, command, scold, or make it sound like a checklist app.",
      "Offer a realistic choice: one minimum version now, postpone, or consciously rest/skip today.",
      "Always Return matters more than a perfect streak.",
    ].join("\n");
    const key = missing.map(({ key: itemKey }) => itemKey).join("+");
    const message = this.systemMessageQueue.enqueue({
      id: `critical-habit:${key}:${crypto.randomUUID()}`,
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text,
      createdAt: now.toISOString(),
    });
    console.log(`[cyberboss] critical habit queued level=A habits=${items.map((item) => item.id).join(",")}`);
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

function buildLevelADirectMessage(items, dailyState = null, supportStrategies = [], { promptKind = "guardian" } = {}) {
  const labels = items.map((item) => item.label).join("、");
  const meanings = items
    .map((item) => item.meaning)
    .filter(Boolean)
    .join("；");
  const completed = (dailyState?.levelA || [])
    .filter((item) => item.completed)
    .map((item) => item.label);
  const mode = dailyState?.recommendedMode === "minimum" ? "minimum" : "standard";
  const fatigue = dailyState?.shiftRating?.found ? dailyState.shiftRating : null;
  const timingReason = dailyState?.priorityTiming?.reason || "";
  const boundaryLabel = dailyState?.priorityTiming?.boundaryLabel || "";
  const intro = buildLevelAIntro({ labels, completed, mode, timingReason, boundaryLabel, fatigue, promptKind });
  const strategyText = supportStrategies.length
    ? `我们之前观察到的规律也支持这一点：${supportStrategies.map((entry) => entry.supportStrategy).join(" ")}`
    : "";
  return [
    intro,
    meanings ? `它们不是打卡，是你给未来自己的地基：${meanings}。` : "它们不是打卡，是你给未来自己的地基。",
    promptKind === "midday"
      ? "现在不是要你立刻把全部做完，只是别让今天从手边溜过去。挑一个最小入口就很好：运动 10 分钟、英语 5 分钟、德语 5 到 10 分钟，哪个更顺手就先碰哪个。"
      : mode === "minimum"
      ? "今天如果身体和脑子都在省电，就做最小版本：运动 10 分钟、英语 5 分钟、德语 5 到 10 分钟，挑一个碰一下也算回来。"
      : "如果现在还来得及，挑一个最小版本碰一下就好；如果今天真的不合适，也可以明确延期或休息。",
    strategyText,
    "重点不是完美，是回来。",
  ].filter(Boolean).join("\n\n");
}

function buildLevelAIntro({ labels, completed, mode, timingReason, boundaryLabel, fatigue, promptKind }) {
  const doneText = completed.length ? `已经完成：${completed.join("、")}。` : "";
  const timingText = timingReason && timingReason !== "fixed_daily_guardian_time"
    ? `${boundaryLabel || "今天的时间边界"}已经靠近了，`
    : "";
  const fatigueText = fatigue?.fatigueBand === "high"
    ? `你刚才给的下班疲惫分是 ${fatigue.score}/10，今天我们按最小版本来，不按完整版本逼自己。`
    : "";
  if (promptKind === "midday") {
    return [
      "Jane，我不催你，只是轻轻把今天的地基放回眼前一下。",
      doneText,
      `现在还没看到 ${labels} 的记录。`,
    ].filter(Boolean).join("\n");
  }
  if (mode === "minimum") {
    return [
      "Jane，我轻轻把你的重点拉回眼前一下。",
      doneText,
      fatigueText,
      `${timingText}今天还没有看到 ${labels} 的记录。`,
    ].filter(Boolean).join("\n");
  }
  return [
    "Jane，我提醒你一下今天最重要的地基。",
    doneText,
    `${timingText}目前还没有看到 ${labels} 的记录。`,
  ].filter(Boolean).join("\n");
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

function isQuietCurrentState(current, config = {}) {
  if (!current?.fresh) {
    return false;
  }
  if (current.state === "going_to_sleep") {
    return true;
  }
  if (current.state === "woke_up") {
    const graceMinutes = Number.isInteger(config.criticalHabitsWakeGraceMinutes)
      ? config.criticalHabitsWakeGraceMinutes
      : 120;
    return current.ageMinutes < graceMinutes;
  }
  return false;
}

function isCalendarBusyNow(dailyState) {
  return Boolean(dailyState?.temporalContext?.currentEvent);
}

function isLevelASoftMiddayDue({ local, config = {}, todayState = null, current = null }) {
  const softHour = Number.isInteger(config.criticalHabitsLevelAMiddayHour)
    ? config.criticalHabitsLevelAMiddayHour
    : 12;
  const softMinute = Number.isInteger(config.criticalHabitsLevelAMiddayMinute)
    ? config.criticalHabitsLevelAMiddayMinute
    : 30;
  const guardianHour = Number.isInteger(config.criticalHabitsLevelAHour)
    ? config.criticalHabitsLevelAHour
    : 20;
  const localMinutes = (local.hour * 60) + (local.minute || 0);
  const softMinutes = (softHour * 60) + Math.max(0, Math.min(59, softMinute));
  if (localMinutes < softMinutes || local.hour >= guardianHour) {
    return false;
  }
  if (isQuietCurrentState(current, config) || isCalendarBusyNow(todayState)) {
    return false;
  }
  const missingLevelA = todayState?.priorityTiming?.missingLevelA;
  if (Array.isArray(missingLevelA) && missingLevelA.length === 0) {
    return false;
  }
  return true;
}

function hasDayStrategySentToday(filePath, date) {
  if (!filePath || !date) {
    return false;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const sent = parsed?.sent && typeof parsed.sent === "object" ? parsed.sent : {};
    return Object.keys(sent).some((key) => key.startsWith(`${date}:`));
  } catch {
    return false;
  }
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
  const dateText = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date: dateText,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
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
  buildLevelADirectMessage,
};
