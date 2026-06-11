const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { dailyReviewExists } = require("./daily-state-service");

class FailureWatchdogService {
  constructor({ config, channelAdapter, sessionStore, dailyInbox, reviewPipeline }) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.dailyInbox = dailyInbox;
    this.reviewPipeline = reviewPipeline;
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
    const recheckDays = Number.isInteger(this.config.failureWatchdogRecheckDays)
      ? this.config.failureWatchdogRecheckDays
      : 7;
    const state = this.loadState();
    let sent = false;

    for (const date of trailingDates(targetDate, Math.max(1, recheckDays))) {
      const key = `daily-review:${date}`;
      const previous = normalizeEntry(state.checked[key]);
      if (previous && previous.ok) {
        continue;
      }

      let evaluation = this.evaluate(date);
      if (!evaluation.ok) {
        this.tryArchiveRepair(date, evaluation);
        evaluation = this.evaluate(date);
      }

      if (evaluation.ok) {
        state.checked[key] = {
          ...previous,
          checkedAt: now.toISOString(),
          ok: true,
          ...(previous ? { recoveredAt: now.toISOString() } : {}),
        };
        if (previous) {
          console.log(`[cyberboss] failure watchdog recovered date=${date}`);
        }
        continue;
      }

      const entry = {
        checkedAt: now.toISOString(),
        ok: false,
        notifiedAt: previous?.notifiedAt || "",
      };
      state.checked[key] = entry;

      if (date === targetDate && !entry.notifiedAt && this.shouldNotify(date)) {
        const target = this.resolveTarget(account);
        if (target.senderId) {
          const attempts = this.reviewPipeline?.statusFor?.(date)?.attempts || 0;
          const text = [
            `Jane，我检查了一下 ${date} 的午夜复盘，自动流程没有成功收尾${attempts ? `（自动补跑已尝试 ${attempts} 次）` : ""}。`,
            ...evaluation.issues.map((issue) => `- ${issue}`),
            "这不是你的问题，是我这边的自动化需要人工看一眼。你不用手动填日记。",
          ].join("\n");
          await this.sendText(target.senderId, text);
          entry.notifiedAt = now.toISOString();
          sent = true;
          console.log(`[cyberboss] failure watchdog notified date=${date} issues=${evaluation.issues.length}`);
        }
      }
    }

    state.checked = pruneChecked(state.checked, targetDate);
    this.saveState(state);
    return { sent, targetDate };
  }

  evaluate(date) {
    const inbox = this.dailyInbox?.read?.({ date }) || { exists: false, filePath: "" };
    const review = dailyReviewExists(this.config, date);
    const archivePath = path.join(this.config.dailyInboxArchiveDir || "", `${date}.md`);
    const archiveExists = Boolean(this.config.dailyInboxArchiveDir) && fs.existsSync(archivePath);
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
    return { ok: issues.length === 0, issues, reviewOk: review.ok, inboxPending: inbox.exists };
  }

  tryArchiveRepair(date, evaluation) {
    if (!evaluation.reviewOk || !evaluation.inboxPending) {
      return;
    }
    if (!this.dailyInbox || typeof this.dailyInbox.archive !== "function") {
      return;
    }
    try {
      const result = this.dailyInbox.archive({ date });
      if (result.archived) {
        console.log(`[cyberboss] failure watchdog auto-archived inbox date=${date}`);
      }
    } catch (error) {
      console.error(`[cyberboss] failure watchdog archive repair failed date=${date}: ${error.message}`);
    }
  }

  shouldNotify(date) {
    if (!this.reviewPipeline || this.config.dailyReviewPipelineEnabled === false) {
      return true;
    }
    const status = this.reviewPipeline.statusFor?.(date);
    return status?.status === "gave_up";
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

function normalizeEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : "",
    ok: Boolean(value.ok),
    notifiedAt: typeof value.notifiedAt === "string" ? value.notifiedAt : "",
    ...(value.recoveredAt ? { recoveredAt: value.recoveredAt } : {}),
  };
}

function pruneChecked(checked, currentDate) {
  const cutoff = addDaysText(currentDate, -60);
  return Object.fromEntries(Object.entries(checked).filter(([key]) => {
    const date = key.startsWith("daily-review:") ? key.slice("daily-review:".length) : "";
    return !date || date >= cutoff;
  }));
}

function trailingDates(dateText, count) {
  const dates = [];
  for (let index = 0; index < count; index += 1) {
    dates.push(addDaysText(dateText, -index));
  }
  return dates;
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
