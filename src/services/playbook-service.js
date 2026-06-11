const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ANCHORS = ["arrived_home", "off_work", "commuting_home", "woke_up", "going_to_sleep"];

// The Playbook stores decisions Jane already made, so the moment itself needs
// none: "if <anchor>, the default action is <one small task>". When her
// current-state anchor fires, the bridge sends ONE short prompt with a single
// pre-decided default and a digit reply to start - no menus, no deliberation.
const DEFAULT_RULES = [
  {
    id: "pb_default_home_sport",
    anchor: "arrived_home",
    task: "Sport",
    label: "运动 10 分钟（最小版）",
    minutes: 10,
    hours: { from: 8, to: 22 },
    enabled: true,
    note: "到家后的默认动作。回 1 启动。想改就直接告诉我。",
  },
  {
    id: "pb_default_wake_german",
    anchor: "woke_up",
    task: "Deutsch",
    label: "德语 10 分钟",
    minutes: 10,
    hours: { from: 8, to: 20 },
    enabled: true,
    note: "休息日睡醒后的默认动作。早班清晨不会触发（8 点前不生效）。",
  },
];

class PlaybookService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.filePath = this.config.playbookFile;
  }

  async upsertRule({ id = "", anchor = "", task = "", label = "", minutes = 10, hours = null, note = "", enabled = true } = {}) {
    const normalizedAnchor = String(anchor || "").trim();
    if (!ANCHORS.includes(normalizedAnchor)) {
      throw new Error(`playbook_set: anchor must be one of ${ANCHORS.join(", ")}.`);
    }
    if (!String(task || "").trim() || !String(label || "").trim()) {
      throw new Error("playbook_set: task and label are required.");
    }
    const state = this._load();
    const normalizedId = String(id || "").trim();
    const existing = normalizedId ? state.rules.find((rule) => rule.id === normalizedId) : null;
    const rule = {
      id: existing?.id || normalizedId || `pb_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
      anchor: normalizedAnchor,
      task: String(task).trim(),
      label: String(label).trim(),
      minutes: clampMinutes(minutes),
      hours: normalizeHours(hours) || existing?.hours || { from: 8, to: 22 },
      note: String(note || existing?.note || "").trim(),
      enabled: enabled !== false,
      updatedAt: new Date().toISOString(),
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    if (existing) {
      state.rules = state.rules.map((item) => (item.id === rule.id ? rule : item));
    } else {
      state.rules.push(rule);
    }
    this._save(state);
    return rule;
  }

  async removeRule({ id = "" } = {}) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      throw new Error("playbook_remove: id is required.");
    }
    const state = this._load();
    const before = state.rules.length;
    state.rules = state.rules.filter((rule) => rule.id !== normalizedId);
    if (state.rules.length === before) {
      throw new Error(`playbook_remove: rule ${normalizedId} not found.`);
    }
    this._save(state);
    return { removed: normalizedId };
  }

  async list() {
    const state = this._load();
    return { rules: state.rules, anchors: ANCHORS };
  }

  // Returns the first enabled rule for this anchor that is inside its hour
  // window and has not fired today. Does not mark it sent - the caller
  // confirms with recordSent once the trigger is actually queued.
  matchAnchor({ anchor = "", now = new Date() } = {}) {
    const state = this._load();
    const local = localParts(now, this.timeZone());
    for (const rule of state.rules) {
      if (!rule.enabled || rule.anchor !== anchor) {
        continue;
      }
      const window = rule.hours || { from: 0, to: 24 };
      if (local.hour < window.from || local.hour >= window.to) {
        continue;
      }
      if (state.sent[`${rule.id}:${local.date}`]) {
        continue;
      }
      return rule;
    }
    return null;
  }

  recordSent(ruleId, now = new Date()) {
    const state = this._load();
    const local = localParts(now, this.timeZone());
    state.sent[`${ruleId}:${local.date}`] = now.toISOString();
    state.sent = pruneSent(state.sent, local.date);
    this._save(state);
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        rules: Array.isArray(parsed?.rules) ? parsed.rules : [],
        sent: parsed?.sent && typeof parsed.sent === "object" ? parsed.sent : {},
      };
    } catch {
      return { rules: DEFAULT_RULES.map((rule) => ({ ...rule })), sent: {} };
    }
  }

  _save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function buildPlaybookTrigger(rule, anchorLabel, userName = "Jane") {
  return [
    "Playbook trigger: DELIVERY REQUIRED.",
    `Anchor: ${anchorLabel} (${rule.anchor}). Pre-decided default action: ${rule.label} (task=${rule.task}, ${rule.minutes} minutes).`,
    `${userName} chose this default in advance precisely so this moment needs zero deliberation. Your job is to remove decision cost, not add it.`,
    "Send ONE very short message:",
    `- one natural phrase that meets the anchor moment`,
    `- the single default action - no menus, no three choices, no meaning lectures`,
    `- end with: 回 1 我帮你开始计时（${rule.minutes} 分钟）`,
    `If she replies 1 (or 好/开始), immediately call cyberboss_focus_start with task=${rule.task} minutes=${rule.minutes} and confirm in one short line.`,
    "If she ignores it or says not now, let it go completely - never re-ask, never guilt.",
    "Silently check daily state first: if she is clearly depleted (high after-shift fatigue, night-shift recovery, illness), replace the action with one line of explicit rest permission instead.",
  ].join("\n");
}

const ANCHOR_LABELS = {
  arrived_home: "到家了",
  off_work: "下班了",
  commuting_home: "下班路上",
  woke_up: "睡醒了",
  going_to_sleep: "准备睡觉",
};

function clampMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 3) {
    return 10;
  }
  return Math.min(Math.round(minutes), 120);
}

function normalizeHours(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const from = Number(value.from);
  const to = Number(value.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  return {
    from: Math.max(0, Math.min(23, Math.round(from))),
    to: Math.max(1, Math.min(24, Math.round(to))),
  };
}

function pruneSent(sent, currentDate) {
  const cutoff = addDaysText(currentDate, -7);
  return Object.fromEntries(Object.entries(sent).filter(([key]) => {
    const date = key.slice(key.lastIndexOf(":") + 1);
    return date >= cutoff;
  }));
}

function localParts(date, timeZone) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
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
  };
}

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

module.exports = { PlaybookService, buildPlaybookTrigger, ANCHOR_LABELS, ANCHORS };
