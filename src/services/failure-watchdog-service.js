const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { dailyReviewExists } = require("./daily-state-service");

class FailureWatchdogService {
  constructor({ config, channelAdapter, sessionStore, dailyInbox }) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.dailyInbox = dailyInbox;
    this.stateFile = this.config.failureWatchdogStateFile;
    this.lastCheckAtMs = 0;
  }

  async check(account, now = new Date()) {
    if (this.config.failureWatchdogEnabled === false) {
      return { sent: false };
    }
    const intervalMs = this.config.failureWatchdogCheckIntervalMs || 900_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { sent: false };
    }
    this.lastCheckAtMs = now.getTime();

    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const local = localDateParts(now, timeZone);
    const hour = Number.isInteger(this.config.failureWatchdogHour) ? this.config.failureWatchdogHour : 2;
    if (local.hour < hour) {
      return { sent: false };
    }

    const targetDate = addDaysText(local.date, -1);
    const state = this.loadState();
    const key = `daily-review:${targetDate}`;
    if (state.checked[key]) {
      return { sent: false };
    }

    const target = this.resolveTarget(account);
    if (!target.senderId) {
      return { sent: false };
    }

    const inbox = this.dailyInbox?.read?.({ date: targetDate }) || { exists: false, filePath: "" };
    const review = dailyReviewExists(this.config, targetDate);
    const archivePath = path.join(this.config.dailyInboxArchiveDir || "", `${targetDate}.md`);
    const archiveExists = archivePath && fs.existsSync(archivePath);
    const issues = [];
    if (!review.ok) {
      issues.push(`Obsidian Daily Review 可能没有成功完成（${review.reason}）。`);
    }
    if (inbox.exists) {
      issues.push("Daily Inbox 还没有归档，说明午夜流程可能没有收尾。");
    }
    if (!archiveExists && inbox.exists) {
      issues.push("当天原始 Inbox 仍留在待处理目录。");
    }

    state.checked[key] = { checkedAt: now.toISOString(), ok: issues.length === 0 };
    this.saveState(state);
    if (!issues.length) {
      return { sent: false };
    }
    const text = [
      `Jane，我检查了一下 ${targetDate} 的午夜复盘，自动流程好像没有完全收尾。`,
      ...issues.map((issue) => `- ${issue}`),
      "这不是你的问题，是我这边的自动化需要补跑。你不用手动填日记，我会把它当成需要处理的后台故障。",
    ].join("\n");
    await this.sendText(target.senderId, text);
    console.log(`[cyberboss] failure watchdog notified date=${targetDate} issues=${issues.length}`);
    return { sent: true, targetDate, issues };
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

  async sendText(senderId, text) {
    if (typeof this.channelAdapter?.sendText !== "function") {
      return;
    }
    await this.channelAdapter.sendText({
      userId: senderId,
      text,
      contextToken: this.channelAdapter.getKnownContextTokens?.()[senderId] || senderId,
    });
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return { checked: parsed?.checked && typeof parsed.checked === "object" ? parsed.checked : {} };
    } catch {
      return { checked: {} };
    }
  }

  saveState(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

module.exports = { FailureWatchdogService };
