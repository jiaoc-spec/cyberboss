const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");

class DecisionReviewMonitor {
  constructor({ config, channelAdapter, sessionStore, systemMessageQueue, decisionJournal }) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.systemMessageQueue = systemMessageQueue;
    this.decisionJournal = decisionJournal;
    this.lastCheckAtMs = 0;
  }

  async check(account, now = new Date()) {
    if (this.config.decisionReviewEnabled === false || !this.systemMessageQueue || !this.decisionJournal) {
      return { queued: [] };
    }
    const intervalMs = this.config.decisionReviewCheckIntervalMs || 3_600_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { queued: [] };
    }
    this.lastCheckAtMs = now.getTime();

    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const local = localDateParts(now, timeZone);
    if (local.hour < (this.config.decisionReviewHour ?? 11)) {
      return { queued: [] };
    }

    const due = typeof this.decisionJournal.listDueForReview === "function"
      ? await this.decisionJournal.listDueForReview({ date: local.date })
      : [];
    if (!due.length) {
      return { queued: [] };
    }

    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot) {
      return { queued: [] };
    }

    const decision = due[0];
    const message = this.systemMessageQueue.enqueue({
      id: `decision-review:${decision.id}`,
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildDecisionReviewTrigger(decision, this.config),
      createdAt: now.toISOString(),
    });
    await this.decisionJournal.markReviewRequested({ id: decision.id, at: now });
    console.log(`[cyberboss] decision review queued id=${decision.id} decided=${decision.date}`);
    return { queued: [message] };
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
}

function buildDecisionReviewTrigger(decision, config = {}) {
  const userName = String(config.userName || "the user").trim();
  return [
    "Decision Journal follow-up: DELIVERY REQUIRED.",
    `${decision.date}，${userName} 记录过一个决定：「${decision.decision}」`,
    decision.expected_outcome ? `当时的预期：${decision.expected_outcome}` : "",
    decision.reasons ? `当时的理由：${decision.reasons}` : "",
    `今天是约定的回访日（review_date=${decision.review_date}）。`,
    "请用自然、轻松、不像问卷的方式问她：这个决定后来怎么样了？符合预期吗？有什么想法变化？",
    `收到她的回答后，用 cyberboss_decision_update 把 later_outcome 和 reflection 写回这条决策（id=${decision.id}）。`,
    "这是 Second Brain 的决策学习闭环，不是绩效检查。如果她现在明显在忙或在休息，可以等下一个自然的对话时机，但今天之内要问。",
    "Return send_message, not silent.",
  ].filter(Boolean).join("\n");
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

module.exports = { DecisionReviewMonitor, buildDecisionReviewTrigger };
