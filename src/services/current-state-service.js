const fs = require("fs");
const path = require("path");

// Order matters: the first matching rule wins. Richer / more specific states
// (e.g. commuting) must come before generic ones (e.g. woke_up), because a
// single message like "我现在去上早班，四点半就起床" contains both.
const STATE_RULES = [
  {
    state: "at_work",
    label: "正在上班",
    pattern: /(今早|今天|今日|早上|清晨)?.{0,8}\d{1,2}[:：]\d{2}.{0,10}(出发|出门|离开).{0,6}(上|去上).{0,4}(早|晚|夜)?班/,
    freshMinutes: 600,
  },
  {
    state: "commuting_to_work",
    label: "正在去上班的路上",
    pattern: /(出门了|在路上|去上(早|晚|夜)?班|赶(车|地铁|公交)去?|坐车去(上班|医院|单位)|上班路上)/,
    freshMinutes: 150,
  },
  {
    state: "at_work",
    label: "正在上班",
    pattern: /(到(单位|医院|公司|病房|站上)了|开始(上班|交接|干活)|在上班|还在上班|正在上班|(?:在|正在)上(早|晚|夜)班|值班中|开始(早|晚|夜)班|上班中)/,
    freshMinutes: 600,
  },
  {
    state: "commuting_home",
    label: "下班回家路上",
    pattern: /((下班|夜班结束|交完?班).{0,8}(坐车|回家|路上)|在回家路上|坐车回家|往家走)/,
    freshMinutes: 120,
  },
  {
    state: "off_work",
    label: "刚下班",
    pattern: /(下班了|夜班结束了?|交班了|放工了)/,
    freshMinutes: 180,
  },
  {
    state: "arrived_home",
    label: "到家了",
    pattern: /(到家了|回到家了?)/,
    freshMinutes: 360,
  },
  {
    state: "going_to_sleep",
    label: "准备睡觉/正在休息",
    pattern: /((去|要|准备|先)睡了?|睡觉了|晚安|躺下了|去补觉|眯一会|睡了)/,
    freshMinutes: 600,
  },
  {
    state: "woke_up",
    label: "已经醒了/起床了",
    pattern: /(睡?醒了|刚睡醒|起床了|刚起来?|起来了|睡不着)/,
    freshMinutes: 240,
  },
];

const CHINESE_HOUR = "(零|一|两|二|三|四|五|六|七|八|九|十一|十二|十|\\d{1,2})";
const SLEEP_AT_PATTERN = new RegExp(`(凌晨|半夜|晚上)?${CHINESE_HOUR}点(半)?(以后|之后|多)?才?(睡着|入睡|睡的|睡$|睡，|睡。)`);
const WOKE_AT_PATTERN = new RegExp(`(早上|凌晨|清晨)?${CHINESE_HOUR}点(半)?(就|才)?(起床|起来|醒)`);

const MAX_ASSERTIONS = 30;

class CurrentStateService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.stateFile = this.config.currentStateFile;
  }

  observeMessage({ text = "", receivedAt = "", provider = "", senderId = "" } = {}) {
    const body = normalizeText(text);
    if (!body || body.startsWith("/")) {
      return { stateUpdated: false };
    }
    const at = parseDateOrNow(receivedAt);
    const senderKey = provider && senderId ? `${provider}:${senderId}` : normalizeText(senderId);
    const state = this.loadState();
    let updated = false;

    const matched = matchStateRule(body);
    if (matched) {
      state.assertions.push({
        state: matched.state,
        label: matched.label,
        assertedAt: at.toISOString(),
        sourceText: body.slice(0, 120),
        senderKey,
      });
      state.assertions = state.assertions.slice(-MAX_ASSERTIONS);
      updated = true;
      console.log(`[cyberboss] current state observed state=${matched.state}`);
    }

    const sleep = parseSleepSpan(body);
    if (sleep) {
      const dateKey = localDateText(at, this.timeZone());
      state.sleep[dateKey] = { ...sleep, recordedAt: at.toISOString(), sourceText: body.slice(0, 120) };
      pruneSleep(state.sleep, dateKey);
      updated = true;
      console.log(`[cyberboss] sleep span observed hours=${sleep.approxHours ?? "?"}`);
    }

    if (updated) {
      this.saveState(state);
    }
    return { stateUpdated: updated, state: matched?.state || "" };
  }

  // Programmatic assertion for non-text sources (location triggers etc.).
  recordAssertion({ state = "", label = "", sourceText = "", at = new Date() } = {}) {
    const rule = STATE_RULES.find((item) => item.state === state);
    if (!rule) {
      return { recorded: false };
    }
    const atDate = at instanceof Date ? at : new Date(at);
    const stateData = this.loadState();
    stateData.assertions.push({
      state,
      label: label || rule.label,
      assertedAt: (Number.isNaN(atDate.getTime()) ? new Date() : atDate).toISOString(),
      sourceText: String(sourceText || "").slice(0, 120),
      senderKey: "system:location",
    });
    stateData.assertions = stateData.assertions.slice(-MAX_ASSERTIONS);
    this.saveState(stateData);
    console.log(`[cyberboss] current state asserted state=${state} source=location`);
    return { recorded: true };
  }

  current({ now = new Date() } = {}) {
    const state = this.loadState();
    const latest = state.assertions[state.assertions.length - 1];
    if (!latest) {
      return null;
    }
    const ageMinutes = Math.round((now.getTime() - Date.parse(latest.assertedAt)) / 60_000);
    if (!Number.isFinite(ageMinutes) || ageMinutes < 0) {
      return null;
    }
    const rule = STATE_RULES.find((item) => item.state === latest.state);
    return {
      ...latest,
      ageMinutes,
      fresh: ageMinutes <= (rule?.freshMinutes ?? 240),
    };
  }

  lastSleep({ now = new Date() } = {}) {
    const state = this.loadState();
    const dateKey = localDateText(now, this.timeZone());
    return state.sleep[dateKey] || null;
  }

  // True while Jane has explicitly said she is commuting to work or working,
  // and that statement is still fresh. Used to defer questions and reminders.
  isBusyNow({ now = new Date() } = {}) {
    const current = this.current({ now });
    if (!current || !current.fresh) {
      return { busy: false };
    }
    if (["commuting_to_work", "at_work"].includes(current.state)) {
      return { busy: true, state: current.state, label: current.label, ageMinutes: current.ageMinutes };
    }
    return { busy: false };
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }

  loadState() {
    return readCurrentStateFile(this.stateFile);
  }

  saveState(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function readCurrentStateFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      assertions: Array.isArray(parsed?.assertions) ? parsed.assertions : [],
      sleep: parsed?.sleep && typeof parsed.sleep === "object" ? parsed.sleep : {},
    };
  } catch {
    return { assertions: [], sleep: {} };
  }
}

// Pure helper for processes that read the state file directly (checkin poller).
function evaluateBusyState(state, now = new Date()) {
  const latest = (state?.assertions || [])[state.assertions.length - 1];
  if (!latest) {
    return { busy: false };
  }
  const ageMinutes = (now.getTime() - Date.parse(latest.assertedAt)) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) {
    return { busy: false };
  }
  const rule = STATE_RULES.find((item) => item.state === latest.state);
  if (!["commuting_to_work", "at_work"].includes(latest.state)) {
    return { busy: false };
  }
  if (ageMinutes > (rule?.freshMinutes ?? 240)) {
    return { busy: false };
  }
  return { busy: true, state: latest.state, label: latest.label, ageMinutes: Math.round(ageMinutes) };
}

function matchStateRule(text) {
  for (const rule of STATE_RULES) {
    if (rule.pattern.test(text)) {
      return rule;
    }
  }
  return null;
}

function parseSleepSpan(text) {
  const sleptMatch = SLEEP_AT_PATTERN.exec(text);
  const wokeMatch = WOKE_AT_PATTERN.exec(text);
  if (!sleptMatch && !wokeMatch) {
    return null;
  }
  const sleptHour = sleptMatch ? toHour(sleptMatch[2], sleptMatch[3], sleptMatch[1]) : null;
  const wokeHour = wokeMatch ? toHour(wokeMatch[2], wokeMatch[3], wokeMatch[1]) : null;
  let approxHours = null;
  if (sleptHour !== null && wokeHour !== null) {
    approxHours = wokeHour - sleptHour;
    if (approxHours <= 0) {
      approxHours += 24;
    }
    approxHours = Math.round(approxHours * 10) / 10;
  }
  return {
    sleptAtHour: sleptHour,
    wokeAtHour: wokeHour,
    approxHours,
  };
}

function toHour(hourText, halfText, prefix) {
  const map = { "零": 0, "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12 };
  let hour = Object.prototype.hasOwnProperty.call(map, hourText) ? map[hourText] : Number(hourText);
  if (!Number.isFinite(hour)) {
    return null;
  }
  if (/晚上/.test(prefix || "") && hour < 12) {
    hour += 12;
  }
  if (halfText) {
    hour += 0.5;
  }
  return hour;
}

function pruneSleep(sleep, currentDateKey) {
  const cutoff = addDaysText(currentDateKey, -7);
  for (const key of Object.keys(sleep)) {
    if (key < cutoff) {
      delete sleep[key];
    }
  }
}

function localDateText(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseDateOrNow(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { CurrentStateService, readCurrentStateFile, evaluateBusyState, matchStateRule, parseSleepSpan };
