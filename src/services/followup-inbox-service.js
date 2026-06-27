const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId } = require("../core/default-targets");

const URL_PATTERN = /(?:https?:\/\/|b23\.tv\/|www\.)[^\s，。！？、)）]+/i;
const RESOURCE_PATTERN = /(视频|影片|课程|文章|播客|podcast|链接|资料|材料|pdf|论文|书|教程|lecture|paper|video|article|course)/i;
const FOLLOWUP_INTENT_PATTERN = /(提醒我|记得|帮我记|帮我盯|别忘|之后看|稍后看|今天.*看|明天.*看|要看|想看|需要看)/i;
const COMPLETE_PATTERN = /(看完了|看了|已看|读完了|读了|听完了|听了|学完了|学了|完成了|搞定了|处理完了|做完了)/i;
const COMPLETE_OBJECT_PATTERN = /(这个|那个|它|视频|影片|课程|文章|播客|链接|资料|材料|pdf|论文|书|教程|video|article|course|paper)/i;
const CANCEL_PATTERN = /(不用提醒|别提醒|取消提醒|不看了|先不看|跳过|放弃|归档|删掉这个提醒|不用管)/i;

class FollowupInboxService {
  constructor({ config, channelAdapter, sessionStore } = {}) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.stateFile = this.config.followupInboxStateFile;
    this.lastCheckAtMs = 0;
  }

  observeIncoming({ text = "", receivedAt = "" } = {}) {
    if (!this.config.followupInboxEnabled) {
      return { recorded: [], closed: [] };
    }
    const body = normalizeText(text);
    if (!body) {
      return { recorded: [], closed: [] };
    }
    const now = parseDateOrNow(receivedAt);
    const state = this.loadState();
    const closed = this.observeCloseIntent(state, body, now);
    const resource = extractResource(body);
    const recorded = resource ? [this.recordResource(state, resource, body, now)] : [];
    if (closed.length || recorded.length) {
      this.saveState(state);
    }
    return { recorded, closed };
  }

  async check(account, now = new Date()) {
    if (!this.config.followupInboxEnabled || !this.channelAdapter) {
      return { sent: [] };
    }
    const intervalMs = Number(this.config.followupInboxCheckIntervalMs) || 300_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { sent: [] };
    }
    this.lastCheckAtMs = now.getTime();

    const local = localDateParts(now, this.timeZone());
    const hour = Number(this.config.followupInboxHour) || 10;
    const minute = Number(this.config.followupInboxMinute) || 0;
    if (local.hour < hour || (local.hour === hour && local.minute < minute)) {
      return { sent: [] };
    }

    const state = this.loadState();
    const due = this.dueItems(state, local.date);
    if (!due.length) {
      return { sent: [] };
    }
    const target = this.resolveTarget(account);
    if (!target.senderId) {
      return { sent: [] };
    }

    const maxItems = Math.max(1, Number(this.config.followupInboxMaxItemsPerMessage) || 3);
    const items = due.slice(0, maxItems);
    await this.channelAdapter.sendText({
      userId: target.senderId,
      contextToken: target.contextToken,
      text: buildFollowupMessage(items, due.length, this.config),
    });

    for (const item of items) {
      item.lastReminderDate = local.date;
      item.lastReminderAt = now.toISOString();
      item.reminderCount = Number(item.reminderCount || 0) + 1;
      item.updatedAt = now.toISOString();
    }
    this.saveState(state);
    return { sent: items };
  }

  dueItems(state, today) {
    return (Array.isArray(state.items) ? state.items : [])
      .filter((item) => item.status === "open")
      .filter((item) => item.firstFollowupDate && item.firstFollowupDate <= today)
      .filter((item) => item.lastReminderDate !== today)
      .sort((left, right) => String(left.firstFollowupDate).localeCompare(String(right.firstFollowupDate))
        || String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  observeCloseIntent(state, body, now) {
    const isComplete = COMPLETE_PATTERN.test(body);
    const isCancel = CANCEL_PATTERN.test(body);
    if (!isComplete && !isCancel) {
      return [];
    }
    const status = isCancel ? "cancelled" : "completed";
    const hasExplicitReference = COMPLETE_OBJECT_PATTERN.test(body) || Boolean(normalizeUrl((body.match(URL_PATTERN) || [])[0] || ""));
    const item = findClosableItem(state, body, { allowImplicit: !hasExplicitReference, now });
    if (!item) {
      return [];
    }
    item.status = status;
    item.closedAt = now.toISOString();
    item.closeText = body;
    item.updatedAt = now.toISOString();
    return [item];
  }

  recordResource(state, resource, body, now) {
    state.items = Array.isArray(state.items) ? state.items : [];
    const createdDate = localDateParts(now, this.timeZone()).date;
    const targetDate = inferTargetDate(body, createdDate);
    const firstFollowupDate = targetDate > createdDate ? targetDate : addDaysText(createdDate, 1);
    const existing = state.items.find((item) => item.status === "open" && item.url && item.url === resource.url);
    const item = existing || {
      id: crypto.randomUUID(),
      status: "open",
      createdAt: now.toISOString(),
      reminderCount: 0,
    };
    item.kind = resource.kind;
    item.title = resource.title;
    item.url = resource.url;
    item.sourceText = body;
    item.targetDate = targetDate;
    item.firstFollowupDate = firstFollowupDate;
    item.updatedAt = now.toISOString();
    if (!existing) {
      state.items.push(item);
    }
    pruneItems(state.items, this.config.followupInboxRetentionDays || 180);
    return item;
  }

  resolveTarget(account) {
    const contextTokens = typeof this.channelAdapter.getKnownContextTokens === "function"
      ? this.channelAdapter.getKnownContextTokens()
      : {};
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: account?.accountId,
      sessionStore: this.sessionStore,
      contextTokens,
    });
    return {
      senderId,
      contextToken: senderId ? String(contextTokens[senderId] || "").trim() : "",
    };
  }

  loadState() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) {
      return { items: [] };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return parsed && typeof parsed === "object" ? { items: Array.isArray(parsed.items) ? parsed.items : [] } : { items: [] };
    } catch {
      return { items: [] };
    }
  }

  saveState(state) {
    if (!this.stateFile) {
      return;
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify({ items: Array.isArray(state.items) ? state.items : [] }, null, 2)}\n`);
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }
}

function extractResource(text) {
  const url = normalizeUrl((text.match(URL_PATTERN) || [])[0] || "");
  const hasResource = Boolean(url) || RESOURCE_PATTERN.test(text);
  if (!hasResource || (!url && !FOLLOWUP_INTENT_PATTERN.test(text))) {
    return null;
  }
  return {
    kind: inferKind(text),
    url,
    title: extractTitle(text, url),
  };
}

function findClosableItem(state, body, { allowImplicit = false, now = new Date() } = {}) {
  const open = (Array.isArray(state.items) ? state.items : [])
    .filter((item) => item.status === "open")
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  if (!open.length) {
    return null;
  }
  const url = normalizeUrl((body.match(URL_PATTERN) || [])[0] || "");
  if (url) {
    const byUrl = open.find((item) => item.url === url);
    if (byUrl) return byUrl;
  }
  const lower = body.toLowerCase();
  const byTitle = open.find((item) => item.title && lower.includes(String(item.title).slice(0, 12).toLowerCase()));
  if (byTitle) {
    return byTitle;
  }
  if (open.length === 1) {
    return open[0];
  }
  if (allowImplicit) {
    return findSingleRecentlyRemindedItem(open, now);
  }
  return open[0];
}

function findSingleRecentlyRemindedItem(openItems, now) {
  const nowMs = now.getTime();
  const recentWindowMs = 12 * 60 * 60 * 1000;
  const recent = openItems
    .map((item) => ({ item, remindedAtMs: Date.parse(item.lastReminderAt || "") }))
    .filter((entry) => Number.isFinite(entry.remindedAtMs) && nowMs - entry.remindedAtMs >= 0 && nowMs - entry.remindedAtMs <= recentWindowMs)
    .sort((left, right) => right.remindedAtMs - left.remindedAtMs);
  if (recent.length === 1) {
    return recent[0].item;
  }
  if (recent.length > 1 && recent[0].remindedAtMs > recent[1].remindedAtMs) {
    return recent[0].item;
  }
  return null;
}

function buildFollowupMessage(items, total, config = {}) {
  const userName = String(config.userName || "").trim() || "Jane";
  const lines = [
    `${userName}，我还替你记着这些没收尾的东西：`,
    ...items.map((item, index) => `${index + 1}. ${item.title}${item.url ? `\n   ${item.url}` : ""}`),
  ];
  if (total > items.length) {
    lines.push(`还有 ${total - items.length} 条我先不一起塞给你，免得太吵。`);
  }
  lines.push("看完直接回「看完了」；如果这条先不要了，回「跳过」就好。我会继续帮你盯着。");
  return lines.join("\n");
}

function inferKind(text) {
  if (/视频|影片|bilibili|b23\.tv|youtube|youtu\.be|video/i.test(text)) return "video";
  if (/播客|podcast/i.test(text)) return "podcast";
  if (/论文|paper|article|文章/i.test(text)) return "article";
  if (/课程|course|lecture|教程/i.test(text)) return "course";
  return "resource";
}

function inferTargetDate(text, createdDate) {
  if (/后天/.test(text)) return addDaysText(createdDate, 2);
  if (/明天/.test(text)) return addDaysText(createdDate, 1);
  return createdDate;
}

function extractTitle(text, url) {
  const withoutUrl = text.replace(URL_PATTERN, " ").replace(/\s+/g, " ").trim();
  const cleaned = withoutUrl
    .replace(/提醒我.*$/, "")
    .replace(/记得.*$/, "")
    .replace(/帮我.*$/, "")
    .replace(/今天.*$/, "")
    .replace(/明天.*$/, "")
    .replace(/[【】]/g, "")
    .trim();
  const candidate = cleaned || withoutUrl || url || "重要内容";
  return candidate.length > 80 ? `${candidate.slice(0, 77)}...` : candidate;
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^b23\.tv\//i.test(text) || /^www\./i.test(text)) {
    return `https://${text}`;
  }
  return text;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseDateOrNow(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour || 0),
    minute: Number(map.minute || 0),
  };
}

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function pruneItems(items, retentionDays) {
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86400000;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.status === "open") continue;
    const closedAt = Date.parse(item.closedAt || item.updatedAt || item.createdAt || "");
    if (Number.isFinite(closedAt) && closedAt < cutoff) {
      items.splice(index, 1);
    }
  }
}

module.exports = { FollowupInboxService };
