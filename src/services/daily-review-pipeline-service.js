const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { dailyReviewExists } = require("./daily-state-service");
const { buildDailyReviewPrompt } = require("./daily-review-prompt");

const RUN_KEY_PREFIX = "daily-review:";
const STATE_RETENTION_DAYS = 14;

class DailyReviewPipelineService {
  constructor({ config, channelAdapter, sessionStore, systemMessageQueue, dailyInbox }) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.systemMessageQueue = systemMessageQueue;
    this.dailyInbox = dailyInbox;
    this.stateFile = this.config.dailyReviewPipelineStateFile;
    this.lastCheckAtMs = 0;
  }

  async check(account, now = new Date()) {
    if (this.config.dailyReviewPipelineEnabled === false || !this.systemMessageQueue) {
      return { action: "disabled" };
    }
    const intervalMs = this.config.dailyReviewPipelineCheckIntervalMs || 300_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { action: "throttled" };
    }
    this.lastCheckAtMs = now.getTime();

    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const local = localDateParts(now, timeZone);
    const startMinutes = (this.config.dailyReviewPipelineHour ?? 0) * 60
      + (this.config.dailyReviewPipelineMinute ?? 15);
    if (local.hour * 60 + local.minute < startMinutes) {
      return { action: "before_window" };
    }

    const targetDate = addDaysText(local.date, -1);
    const state = this.loadState();
    const key = `${RUN_KEY_PREFIX}${targetDate}`;
    const entry = state.runs[key] || { attempts: 0, status: "pending" };
    if (entry.status === "complete" || entry.status === "gave_up") {
      return { action: "settled", targetDate, status: entry.status };
    }

    const review = dailyReviewExists(this.config, targetDate);
    if (review.ok) {
      entry.status = "complete";
      entry.completedAt = now.toISOString();
      this.persistEntry(state, key, entry, targetDate);
      this.archiveInboxIfPending(targetDate);
      console.log(`[cyberboss] daily review pipeline complete date=${targetDate} attempts=${entry.attempts}`);
      return { action: "complete", targetDate };
    }

    const maxAttempts = this.config.dailyReviewPipelineMaxAttempts || 3;
    if (entry.attempts >= maxAttempts) {
      entry.status = "gave_up";
      entry.gaveUpAt = now.toISOString();
      this.persistEntry(state, key, entry, targetDate);
      console.error(`[cyberboss] daily review pipeline gave up date=${targetDate} attempts=${entry.attempts}`);
      return { action: "gave_up", targetDate };
    }

    const retryDelayMs = this.config.dailyReviewPipelineRetryDelayMs || 45 * 60_000;
    const lastAttemptMs = entry.lastAttemptAt ? Date.parse(entry.lastAttemptAt) : 0;
    if (lastAttemptMs && now.getTime() - lastAttemptMs < retryDelayMs) {
      return { action: "waiting_retry", targetDate };
    }
    if (this.systemMessageQueue.hasPendingForAccount(account.accountId)) {
      return { action: "queue_busy", targetDate };
    }

    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot) {
      return { action: "no_target", targetDate };
    }

    entry.attempts += 1;
    entry.lastAttemptAt = now.toISOString();
    entry.status = "pending";
    this.systemMessageQueue.enqueue({
      id: `daily-review:${targetDate}:attempt-${entry.attempts}`,
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildDailyReviewPrompt(targetDate, {
        obsidianDailyFolder: this.config.obsidianDailyFolder,
        attempt: entry.attempts,
        reason: "scheduled",
      }),
      createdAt: now.toISOString(),
    });
    this.persistEntry(state, key, entry, targetDate);
    console.log(`[cyberboss] daily review pipeline queued date=${targetDate} attempt=${entry.attempts}/${maxAttempts}`);
    return { action: "queued", targetDate, attempt: entry.attempts };
  }

  statusFor(targetDate) {
    const state = this.loadState();
    return state.runs[`${RUN_KEY_PREFIX}${targetDate}`] || null;
  }

  archiveInboxIfPending(targetDate) {
    if (!this.dailyInbox || typeof this.dailyInbox.archive !== "function") {
      return;
    }
    try {
      const result = this.dailyInbox.archive({ date: targetDate });
      if (result.archived) {
        console.log(`[cyberboss] daily review pipeline archived inbox date=${targetDate}`);
      }
    } catch (error) {
      console.error(`[cyberboss] daily review pipeline inbox archive failed date=${targetDate}: ${error.message}`);
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

  persistEntry(state, key, entry, targetDate) {
    state.runs[key] = entry;
    state.runs = pruneRuns(state.runs, targetDate);
    this.saveState(state);
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return { runs: parsed?.runs && typeof parsed.runs === "object" ? parsed.runs : {} };
    } catch {
      return { runs: {} };
    }
  }

  saveState(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function pruneRuns(runs, currentDate) {
  const cutoff = addDaysText(currentDate, -STATE_RETENTION_DAYS);
  return Object.fromEntries(Object.entries(runs).filter(([key]) => {
    const date = key.slice(RUN_KEY_PREFIX.length);
    return date >= cutoff;
  }));
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

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

module.exports = { DailyReviewPipelineService };
