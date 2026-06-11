const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");

const RESURFACE_INTERVALS_DAYS = [7, 30];
const STATE_RETENTION_DAYS = 60;

// Spaced resurfacing: a captured knowledge note quietly comes back 7 and 30
// days later, in the evening, at most one per day - the cheapest reliable
// way to turn captured notes into retained knowledge.
class KnowledgeResurfaceService {
  constructor({ config, channelAdapter, sessionStore, systemMessageQueue, currentState }) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.systemMessageQueue = systemMessageQueue;
    this.currentState = currentState;
    this.stateFile = this.config.knowledgeResurfaceStateFile;
    this.lastCheckAtMs = 0;
  }

  async check(account, now = new Date()) {
    if (this.config.knowledgeResurfaceEnabled === false || !this.systemMessageQueue) {
      return { queued: [] };
    }
    const intervalMs = 3_600_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { queued: [] };
    }
    this.lastCheckAtMs = now.getTime();

    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const local = localParts(now, timeZone);
    if (local.hour < (this.config.knowledgeResurfaceHour ?? 17)) {
      return { queued: [] };
    }
    const busy = this.currentState?.isBusyNow?.({ now });
    if (busy?.busy) {
      return { queued: [] };
    }

    const state = this.loadState();
    if (state.sentDates[local.date]) {
      return { queued: [] };
    }

    const candidate = this.findDueNote(local.date, state);
    if (!candidate) {
      return { queued: [] };
    }

    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot) {
      return { queued: [] };
    }

    const message = this.systemMessageQueue.enqueue({
      id: `knowledge-resurface:${candidate.key}`,
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildResurfaceTrigger(candidate, this.config),
      createdAt: now.toISOString(),
    });
    state.resurfaced[candidate.key] = now.toISOString();
    state.sentDates[local.date] = now.toISOString();
    state.sentDates = pruneByDate(state.sentDates, local.date);
    state.resurfaced = pruneResurfaced(state.resurfaced, local.date);
    this.saveState(state);
    console.log(`[cyberboss] knowledge resurface queued note=${candidate.name} interval=${candidate.intervalDays}d`);
    return { queued: [message] };
  }

  findDueNote(todayDate, state) {
    const inboxDir = path.join(this.resolveVaultDir(), this.config.knowledgeInboxFolder || "");
    let entries = [];
    try {
      entries = fs.readdirSync(inboxDir).filter((name) => name.endsWith(".md"));
    } catch {
      return null;
    }
    for (const intervalDays of RESURFACE_INTERVALS_DAYS) {
      const targetCreated = addDaysText(todayDate, -intervalDays);
      for (const name of entries) {
        const filePath = path.join(inboxDir, name);
        const created = readCreatedDate(filePath);
        if (created !== targetCreated) {
          continue;
        }
        const key = `${name}:${intervalDays}`;
        if (state.resurfaced[key]) {
          continue;
        }
        return {
          key,
          name: name.replace(/\.md$/, ""),
          filePath,
          createdDate: created,
          intervalDays,
          excerpt: readExcerpt(filePath),
        };
      }
    }
    return null;
  }

  resolveVaultDir() {
    const configured = String(this.config.obsidianVaultDir || "").trim();
    if (configured) {
      return configured;
    }
    return path.join(
      os.homedir(),
      "Library/Mobile Documents/iCloud~md~obsidian/Documents/Jiao's Obsidian",
    );
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

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return {
        resurfaced: parsed?.resurfaced && typeof parsed.resurfaced === "object" ? parsed.resurfaced : {},
        sentDates: parsed?.sentDates && typeof parsed.sentDates === "object" ? parsed.sentDates : {},
      };
    } catch {
      return { resurfaced: {}, sentDates: {} };
    }
  }

  saveState(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function buildResurfaceTrigger(candidate, config = {}) {
  const userName = String(config.userName || "the user").trim();
  return [
    "Knowledge resurface: DELIVERY REQUIRED.",
    `${candidate.intervalDays} 天前（${candidate.createdDate}）${userName} 记下过一条知识笔记：《${candidate.name}》`,
    candidate.excerpt ? `内容摘录：${candidate.excerpt}` : "",
    `完整笔记在：${candidate.filePath}`,
    "用一条很短、很自然的消息把它带回来——像朋友想起一件有意思的事，不是复习提醒。可以问一个让她主动回忆的小问题（提取练习比重读有效），或者把它和她最近聊过的事连起来。",
    "不要说'根据间隔重复原理'这类话，不要列要点，不要超过两三句。她不回也完全没关系。",
    "Return send_message, not silent.",
  ].filter(Boolean).join("\n");
}

function readCreatedDate(filePath) {
  try {
    const head = fs.readFileSync(filePath, "utf8").slice(0, 400);
    const match = /^created:\s*(\d{4}-\d{2}-\d{2})/m.exec(head);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function readExcerpt(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const body = text.replace(/^---[\s\S]*?---/, "").replace(/^#.*$/m, "").trim();
    return body.split("\n").map((line) => line.trim()).filter(Boolean).join(" ").slice(0, 160);
  } catch {
    return "";
  }
}

function pruneByDate(map, currentDate) {
  const cutoff = addDaysText(currentDate, -7);
  return Object.fromEntries(Object.entries(map).filter(([date]) => date >= cutoff));
}

function pruneResurfaced(map, currentDate) {
  const cutoff = Date.parse(`${addDaysText(currentDate, -STATE_RETENTION_DAYS)}T00:00:00Z`);
  return Object.fromEntries(Object.entries(map).filter(([, sentAt]) => {
    const parsed = Date.parse(sentAt);
    return Number.isFinite(parsed) && parsed >= cutoff;
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

module.exports = { KnowledgeResurfaceService };
