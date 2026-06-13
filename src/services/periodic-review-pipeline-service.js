const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");

const WEEKLY_MARKER = "## 每周复盘";
const MONTHLY_MARKER = "## 每月复盘";
const STATE_RETENTION = 20;

// Deterministic weekly (Sunday evening) and monthly (1st-3rd morning) review
// pipelines. Like the daily pipeline: queue a contract, verify the artifact,
// retry with delay, give up loudly in the log instead of silently never running.
class PeriodicReviewPipelineService {
  constructor({ config, channelAdapter, sessionStore, systemMessageQueue }) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.systemMessageQueue = systemMessageQueue;
    this.stateFile = this.config.periodicReviewPipelineStateFile;
    this.lastCheckAtMs = 0;
  }

  async check(account, now = new Date()) {
    if (!this.systemMessageQueue) {
      return { actions: [] };
    }
    const intervalMs = 600_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { actions: [] };
    }
    this.lastCheckAtMs = now.getTime();

    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const local = localDateParts(now, timeZone);
    const actions = [];

    if (this.config.weeklyReviewPipelineEnabled !== false
      && local.weekday === 7
      && local.hour >= (this.config.weeklyReviewPipelineHour ?? 20)) {
      const weekKey = isoWeekKey(local.date);
      actions.push(await this.runCadence(account, now, {
        kind: "weekly",
        runKey: `weekly:${weekKey}`,
        targetFile: path.join(this.resolveVaultDir(), this.config.obsidianWeeklyFolder || "", `${weekKey}.md`),
        marker: WEEKLY_MARKER,
        prompt: this.buildWeeklyPrompt(weekKey, local.date),
      }));
    }

    if (this.config.monthlyReviewPipelineEnabled !== false
      && local.day <= 3
      && local.hour >= (this.config.monthlyReviewPipelineHour ?? 9)) {
      const previousMonth = previousMonthKey(local.date);
      actions.push(await this.runCadence(account, now, {
        kind: "monthly",
        runKey: `monthly:${previousMonth}`,
        targetFile: path.join(this.resolveVaultDir(), this.config.obsidianMonthlyFolder || "", `${previousMonth}.md`),
        marker: MONTHLY_MARKER,
        prompt: this.buildMonthlyPrompt(previousMonth),
      }));
    }

    return { actions: actions.filter(Boolean) };
  }

  async runCadence(account, now, { kind, runKey, targetFile, marker, prompt }) {
    const state = this.loadState();
    const entry = state.runs[runKey] || { attempts: 0, status: "pending" };
    if (entry.status === "complete" || entry.status === "gave_up") {
      return null;
    }

    if (fileContainsMarker(targetFile, marker)) {
      entry.status = "complete";
      entry.completedAt = now.toISOString();
      this.persist(state, runKey, entry);
      console.log(`[cyberboss] ${kind} review pipeline complete run=${runKey} attempts=${entry.attempts}`);
      return { kind, action: "complete", runKey };
    }

    const maxAttempts = this.config.periodicReviewPipelineMaxAttempts || 3;
    if (entry.attempts >= maxAttempts) {
      entry.status = "gave_up";
      entry.gaveUpAt = now.toISOString();
      this.persist(state, runKey, entry);
      console.error(`[cyberboss] ${kind} review pipeline gave up run=${runKey} attempts=${entry.attempts}`);
      return { kind, action: "gave_up", runKey };
    }

    const retryDelayMs = this.config.periodicReviewPipelineRetryDelayMs || 60 * 60_000;
    const lastAttemptMs = entry.lastAttemptAt ? Date.parse(entry.lastAttemptAt) : 0;
    if (lastAttemptMs && now.getTime() - lastAttemptMs < retryDelayMs) {
      return null;
    }
    if (this.systemMessageQueue.hasPendingForAccount(account.accountId)) {
      return null;
    }
    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot) {
      return null;
    }

    entry.attempts += 1;
    entry.lastAttemptAt = now.toISOString();
    this.systemMessageQueue.enqueue({
      id: `${runKey}:attempt-${entry.attempts}`,
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: prompt,
      createdAt: now.toISOString(),
    });
    this.persist(state, runKey, entry);
    console.log(`[cyberboss] ${kind} review pipeline queued run=${runKey} attempt=${entry.attempts}/${maxAttempts}`);
    return { kind, action: "queued", runKey, attempt: entry.attempts };
  }

  buildWeeklyPrompt(weekKey, todayDate) {
    const weeklyFolder = this.config.obsidianWeeklyFolder || "03. 🔵 Tagebuch/02. 周记";
    const dailyFolder = this.config.obsidianDailyFolder || "03. 🔵 Tagebuch/01. 日记";
    return `[WEEKLY REVIEW PIPELINE week=${weekKey}] [COMPLEX_TASK requires_tools=true no_deepseek_fallback=true]

如果你是 DeepSeek fallback 而非主 runtime，请直接回复 {"action":"silent"}。

---

请生成 ${weekKey} 的每周复盘，写入 Obsidian：${weeklyFolder}/${weekKey}.md

- 读取用 cyberboss_obsidian_note_read，写入必须用 cyberboss_obsidian_note_write（mode=append）；绝对不要用 shell 或 apply_patch 直接改 vault 文件（会触发人工审批）
- 如果文件已存在（含 Jane 自己的模板和 dataview），追加一个 "${WEEKLY_MARKER}" section，不要动已有内容
- 数据源：${dailyFolder}/ 本周 7 天的 Daily Note（截至 ${todayDate}）、~/.cyberboss/pattern-ledger.json、wins-ledger.json、decision-journal.json、research-ledger.json、apple-calendar-cache.json

每周复盘的职责（不是日记汇总）：
1. 合并本周 Daily Review 的 Pattern Ledger 证据：用 cyberboss_pattern_ledger_add_evidence / upsert 修订 confidence，矛盾的 pattern 降级或标 contradicted
2. 用 cyberboss_wins_query 看本周成功因素的分布，写出本周"什么条件下事情会发生"
3. 检查 cyberboss_decision_list pending_review_only 的决策，有可更新的就更新
4. Level A/B/C 的连续性：完成、断掉、回来的入口，按 Always Return 框架写，不指责
5. Identity Ledger / Be-Do-Have：不要只统计 habit 次数。把本周 evidence 聚合到四条身份主线：健康体能、语言能力、护理科学/教学科研、舞蹈表达。写清楚哪个身份本周被照顾，哪个身份缺席，缺席的最小回来入口是什么。
6. 能量/睡眠/班次模式：本周班次结构对状态的影响，事实与假设分开
7. 下周最小起步：一条具体的、最小版本的下周入口，优先选择最缺席但最重要的身份主线

完成后返回 {"action":"silent"}。`;
  }

  buildMonthlyPrompt(monthKey) {
    const monthlyFolder = this.config.obsidianMonthlyFolder || "03. 🔵 Tagebuch/03. 月记";
    const weeklyFolder = this.config.obsidianWeeklyFolder || "03. 🔵 Tagebuch/02. 周记";
    return `[MONTHLY REVIEW PIPELINE month=${monthKey}] [COMPLEX_TASK requires_tools=true no_deepseek_fallback=true]

如果你是 DeepSeek fallback 而非主 runtime，请直接回复 {"action":"silent"}。

---

请生成 ${monthKey} 的每月复盘，写入 Obsidian：${monthlyFolder}/${monthKey}.md

- 读取用 cyberboss_obsidian_note_read，写入必须用 cyberboss_obsidian_note_write（mode=append）；绝对不要用 shell 或 apply_patch 直接改 vault 文件（会触发人工审批）
- 文件已存在则追加 "${MONTHLY_MARKER}" section，不要覆盖已有内容
- 数据源优先用 ${weeklyFolder}/ 该月的周记（不要从原始聊天重建），加上 pattern-ledger.json、wins-ledger.json、decision-journal.json、research-ledger.json

每月复盘的职责：
1. Pattern Ledger 长期修订：confidence 升降、retire 矛盾 pattern、把 3+ 次观察的 hypothesis 升为 active；这是月度的核心任务
2. 学术资产盘点：用 cyberboss_research_query 统计本月论文/想法/写作/课程的积累，写一段"这个月你的学术资产增加了什么"
3. 月度决策回顾：本月记录和回访的决定，提炼决策模式
4. 身份体检 / Be-Do-Have：按"她正在成为谁"评估，而不是按任务清单评估。至少覆盖：健康体能的人、德语/英语能力优秀的人、护理科学家/教授/教师/ANP/研究者、持续跳舞的人。写出每个身份本月的证据、缺口、自然生长点、被遗忘点。
5. 长期目标体检：Level A/B/C 与大学→科研路径的连接是否还活着，哪些方向在自然生长，哪些被遗忘
6. 知识卡区维护（lint）：用 cyberboss_obsidian_note_read 看 ${this.config.knowledgeFolder || "01. ⚪ Wissenskarte"}/00. 知识地图.md 和概念卡，找出断链（指向不存在的 [[ ]]）、孤儿卡（没被任何卡或 MOC 链接）、明显重复的概念。只在月复盘里**列出**这些问题供 Jane 决定，不要自动删除或合并任何笔记。
7. 下月一个最重要的调整建议（只一个），必须对应一个身份主线，而不是泛泛建议

完成后返回 {"action":"silent"}。`;
  }

  resolveVaultDir() {
    const configured = normalizeText(this.config.obsidianVaultDir);
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

  persist(state, runKey, entry) {
    state.runs[runKey] = entry;
    const keys = Object.keys(state.runs).sort();
    while (keys.length > STATE_RETENTION) {
      delete state.runs[keys.shift()];
    }
    this.saveState(state);
  }

  statusFor(runKey) {
    return this.loadState().runs[runKey] || null;
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

function fileContainsMarker(filePath, marker) {
  try {
    return fs.readFileSync(filePath, "utf8").includes(marker);
  } catch {
    return false;
  }
}

function isoWeekKey(dateText) {
  const date = new Date(`${dateText}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function previousMonthKey(dateText) {
  const [year, month] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 15));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
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
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day: Number(parts.day),
    hour: Number(parts.hour),
    weekday: ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[parts.weekday] || 0,
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { PeriodicReviewPipelineService };
