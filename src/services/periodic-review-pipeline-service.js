const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { ObsidianNoteService } = require("./obsidian-note-service");

const WEEKLY_MARKER = "## 每周复盘";
const MONTHLY_MARKER = "## 每月复盘";
const STATE_RETENTION = 20;

// Deterministic weekly (after the week has fully ended) and monthly (1st-3rd morning) review
// pipelines. Like the daily pipeline: queue a contract, verify the artifact,
// retry with delay, give up loudly in the log instead of silently never running.
class PeriodicReviewPipelineService {
  constructor({ config, channelAdapter, sessionStore, systemMessageQueue }) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.systemMessageQueue = systemMessageQueue;
    this.stateFile = this.config.periodicReviewPipelineStateFile;
    this.obsidianNote = new ObsidianNoteService({ config: this.config });
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

    const weeklyWeekday = this.config.weeklyReviewPipelineWeekday ?? 1;
    if (this.config.weeklyReviewPipelineEnabled !== false
      && local.weekday === weeklyWeekday
      && local.hour >= (this.config.weeklyReviewPipelineHour ?? 4)) {
      const weekKey = previousIsoWeekKey(local.date);
      const range = isoWeekRange(weekKey);
      const relativePath = path.join(this.config.obsidianWeeklyFolder || "", `${weekKey}.md`);
      actions.push(await this.runCadence(account, now, {
        kind: "weekly",
        runKey: `weekly:${weekKey}`,
        periodKey: weekKey,
        relativePath,
        targetFile: path.join(this.resolveVaultDir(), relativePath),
        marker: WEEKLY_MARKER,
        prompt: this.buildWeeklyPrompt(weekKey, range.end),
      }));
    }

    if (this.config.monthlyReviewPipelineEnabled !== false
      && local.day <= 3
      && local.hour >= (this.config.monthlyReviewPipelineHour ?? 9)) {
      const previousMonth = previousMonthKey(local.date);
      const relativePath = path.join(this.config.obsidianMonthlyFolder || "", `${previousMonth}.md`);
      actions.push(await this.runCadence(account, now, {
        kind: "monthly",
        runKey: `monthly:${previousMonth}`,
        periodKey: previousMonth,
        relativePath,
        targetFile: path.join(this.resolveVaultDir(), relativePath),
        marker: MONTHLY_MARKER,
        prompt: this.buildMonthlyPrompt(previousMonth),
      }));
    }

    return { actions: actions.filter(Boolean) };
  }

  async runCadence(account, now, { kind, runKey, periodKey, relativePath, targetFile, marker, prompt }) {
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

    if (this.config.periodicReviewBridgeFallbackEnabled !== false && entry.attempts > 0) {
      try {
        const fallback = await this.writeBridgeFallback({ kind, periodKey, relativePath, marker, now });
        if (fallback?.written) {
          entry.status = "complete";
          entry.completedAt = now.toISOString();
          entry.completedBy = "bridge_fallback";
          entry.bridgeFallbackAt = now.toISOString();
          this.persist(state, runKey, entry);
          console.log(`[cyberboss] ${kind} review pipeline bridge fallback complete run=${runKey} file=${fallback.relativePath}`);
          return { kind, action: "bridge_fallback", runKey, relativePath: fallback.relativePath };
        }
      } catch (error) {
        console.error(`[cyberboss] ${kind} review pipeline bridge fallback failed run=${runKey}: ${error?.stack || error?.message || error}`);
      }
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

  async writeBridgeFallback({ kind, periodKey, relativePath, marker, now }) {
    const content = kind === "monthly"
      ? await this.buildMonthlyBridgeReview(periodKey, now)
      : await this.buildWeeklyBridgeReview(periodKey, now);
    const result = await this.obsidianNote.write({
      relativePath,
      mode: "append",
      content: `${marker}\n\n${content}`.replace(/\n*$/, "\n"),
    });
    return { written: true, relativePath: result.relativePath, filePath: result.filePath };
  }

  async buildWeeklyBridgeReview(weekKey, now) {
    const range = isoWeekRange(weekKey);
    const dates = datesBetween(range.start, range.end);
    const notes = await this.readDailyNotes(dates);
    const wins = this.readLedgerItems(this.config.winsLedgerFile, "wins")
      .filter((item) => dateInRange(item.date, range.start, range.end));
    const decisions = this.readLedgerItems(this.config.decisionJournalFile, "decisions")
      .filter((item) => dateInRange(item.date, range.start, range.end) || dateInRange(item.review_date, range.start, range.end));
    const patterns = this.readLedgerItems(this.config.patternLedgerFile, "patterns");
    const evidence = buildEvidenceSummary(notes);
    const patternLines = summarizePatterns(patterns, range.start, range.end);
    const winLines = summarizeWins(wins);
    const decisionLines = summarizeDecisions(decisions);
    const suggestedEntry = chooseSmallestEntry(evidence);

    return [
      `数据范围：${range.start} 到 ${range.end}`,
      "",
      "### 本周 Big Picture",
      `- 有 Daily Note 证据的天数：${notes.length}/${dates.length} 天。`,
      `- Level A / 基础身份证据：运动 ${evidence.sport.positiveDays} 天，英语 ${evidence.english.positiveDays} 天，德语 ${evidence.german.positiveDays} 天。`,
      `- 塑形 / 身体结构维护证据：${evidence.bodyShaping.positiveDays} 天；身体照顾总证据：${evidence.health.positiveDays} 天；职业与学术成长证据：${evidence.academic.positiveDays} 天；舞蹈 / 身体表达证据：${evidence.dance.positiveDays} 天；恢复与班次线索：${evidence.recovery.mentionDays} 天。`,
      "",
      "### 身份主线",
      `- 健康体能的人：${identityLine(evidence.health, "本周有身体照顾的证据", "本周健康体能线索偏少，适合用 10 分钟版本重新回来。")}`,
      `- 语言能力优秀的人：英语 ${identityLine(evidence.english, "有发音 / 英语投入证据", "英语证据偏少，先从 5 分钟发音开始就够。")} 德语 ${identityLine(evidence.german, "有语法 / 影子跟读证据", "德语证据偏少，先从 5-10 分钟影子跟读回来。")}`,
      `- 护理科学 / 教学科研的人：${identityLine(evidence.academic, "有专业学习、课程、文献或项目推进证据", "本周学术线索较少，先保留一个很小的阅读或整理入口。")}`,
      `- 持续跳舞的人：${identityLine(evidence.dance, "有舞蹈或基本功证据", "舞蹈线索偏少，可以先用一首歌或 10 分钟基本功回来。")}`,
      "",
      "### 什么条件下事情会发生",
      ...winLines,
      "",
      "### 观察到的模式",
      ...patternLines,
      "",
      "### 决策与 Open Loops",
      ...decisionLines,
      "",
      "### 下周最小入口",
      `- ${suggestedEntry}`,
      "",
      "说明：这里优先使用 Daily Notes 和本地 ledger 中已经存在的证据；信息不足的地方保持 unknown，不补故事。",
      `更新于：${formatLocalTimestamp(now, this.config.timeZone || this.config.diaryTimeZone || "UTC")}`,
    ].join("\n");
  }

  async buildMonthlyBridgeReview(monthKey, now) {
    const range = monthRange(monthKey);
    const dates = datesBetween(range.start, range.end);
    const notes = await this.readDailyNotes(dates);
    const wins = this.readLedgerItems(this.config.winsLedgerFile, "wins")
      .filter((item) => dateInRange(item.date, range.start, range.end));
    const decisions = this.readLedgerItems(this.config.decisionJournalFile, "decisions")
      .filter((item) => dateInRange(item.date, range.start, range.end) || dateInRange(item.review_date, range.start, range.end));
    const patterns = this.readLedgerItems(this.config.patternLedgerFile, "patterns");
    const evidence = buildEvidenceSummary(notes);
    const patternLines = summarizePatterns(patterns, range.start, range.end, 5);
    const winLines = summarizeWins(wins, 5);
    const decisionLines = summarizeDecisions(decisions, 5);

    return [
      `数据范围：${range.start} 到 ${range.end}`,
      "",
      "### 月度 Big Picture",
      `- 有 Daily Note 证据的天数：${notes.length}/${dates.length} 天。`,
      `- 身份证据：运动 ${evidence.sport.positiveDays} 天，塑形 / 身体结构维护 ${evidence.bodyShaping.positiveDays} 天，身体照顾总证据 ${evidence.health.positiveDays} 天，英语 ${evidence.english.positiveDays} 天，德语 ${evidence.german.positiveDays} 天，职业 / 学术 ${evidence.academic.positiveDays} 天，舞蹈表达 ${evidence.dance.positiveDays} 天。`,
      "",
      "### 身份体检 / Be-Do-Have",
      `- 健康体能：${identityLine(evidence.health, "这个身份本月有持续证据", "这个身份本月证据偏少，下月应保留最低版本。")}`,
      `- 语言能力：英语 ${identityLine(evidence.english, "有输入或练习证据", "英语需要一个更小的可重复入口。")} 德语 ${identityLine(evidence.german, "有输入或练习证据", "德语需要一个更小的可重复入口。")}`,
      `- 护理科学 / 教学科研：${identityLine(evidence.academic, "有专业成长证据", "本月学术资产证据不足，适合安排小规模文献或课程复盘。")}`,
      `- 舞蹈表达：${identityLine(evidence.dance, "有身体表达证据", "这个身份容易被工作和恢复挤掉，可以先用短练习回来。")}`,
      "",
      "### 成功条件",
      ...winLines,
      "",
      "### 长期模式",
      ...patternLines,
      "",
      "### 决策回顾",
      ...decisionLines,
      "",
      "### 下月一个调整",
      `- 先保护证据最少、但和未来身份最相关的一条主线：${chooseSmallestEntry(evidence)}`,
      "",
      "说明：这里优先使用本月 Daily Notes 和本地 ledger 中已经存在的证据；信息不足的地方保持 unknown，不补故事。",
      `更新于：${formatLocalTimestamp(now, this.config.timeZone || this.config.diaryTimeZone || "UTC")}`,
    ].join("\n");
  }

  async readDailyNotes(dates) {
    const folder = this.config.obsidianDailyFolder || "03. 🔵 Tagebuch/01. 日记";
    const notes = [];
    for (const date of dates) {
      try {
        const note = await this.obsidianNote.read({ relativePath: path.join(folder, `${date}.md`) });
        if (note.exists && note.text.trim()) {
          notes.push({ date, text: note.text });
        }
      } catch {
        // Keep unattended reviews robust: missing or unreadable notes simply mean unknown.
      }
    }
    return notes;
  }

  readLedgerItems(filePath, key) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(parsed?.[key]) ? parsed[key] : [];
    } catch {
      return [];
    }
  }

  buildWeeklyPrompt(weekKey, todayDate) {
    const weeklyFolder = this.config.obsidianWeeklyFolder || "03. 🔵 Tagebuch/02. 周记";
    const dailyFolder = this.config.obsidianDailyFolder || "03. 🔵 Tagebuch/01. 日记";
    return `[WEEKLY REVIEW PIPELINE week=${weekKey}] [COMPLEX_TASK requires_tools=true no_deepseek_fallback=true]

如果你是 DeepSeek fallback 而非主 runtime，请直接回复 {"action":"silent"}。
如果任何 Obsidian 读写工具不可用或失败，不要给 Jane 发送“工具断了 / 没法写入”之类消息；直接返回 {"action":"silent"}，bridge 会自动重试或兜底写入。

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
如果任何 Obsidian 读写工具不可用或失败，不要给 Jane 发送“工具断了 / 没法写入”之类消息；直接返回 {"action":"silent"}，bridge 会自动重试或兜底写入。

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

function previousIsoWeekKey(dateText) {
  return isoWeekKey(toDateText(addDays(parseDateText(dateText), -7)));
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

function isoWeekRange(weekKey) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(weekKey || ""));
  if (!match) {
    const today = new Date();
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    return { start: toDateText(date), end: toDateText(addDays(date, 6)) };
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = addDays(jan4, 1 - jan4Day + (week - 1) * 7);
  return { start: toDateText(monday), end: toDateText(addDays(monday, 6)) };
}

function monthRange(monthKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ""));
  if (!match) {
    const today = new Date();
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    return { start: toDateText(start), end: toDateText(end) };
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  return { start: toDateText(start), end: toDateText(end) };
}

function datesBetween(startText, endText) {
  const dates = [];
  let cursor = parseDateText(startText);
  const end = parseDateText(endText);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(toDateText(cursor));
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function parseDateText(value) {
  const text = String(value || "").slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    return new Date(Date.UTC(1970, 0, 1));
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toDateText(date) {
  return date.toISOString().slice(0, 10);
}

function dateInRange(value, start, end) {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && text >= start && text <= end;
}

function buildEvidenceSummary(notes) {
  return {
    sport: summarizeEvidence(notes, /(运动|sport|健身|有氧操|力量训练|跑步|workout|training)/i),
    bodyShaping: summarizeEvidence(notes, /(塑形|骨盆|武当\s*1\s*\+?\s*2|武当|足弓|pelvic|foot arch)/i),
    health: summarizeEvidence(notes, /(运动|sport|健身|有氧操|塑形|骨盆|武当\s*1\s*\+?\s*2|武当|足弓|力量训练|基本功|美容灯|跑步|workout|training|pelvic|foot arch)/i),
    english: summarizeEvidence(notes, /(英语|englisch|english|rachel|发音)/i),
    german: summarizeEvidence(notes, /(德语|deutsch|语法|影子跟读)/i),
    academic: summarizeEvidence(notes, /(praxisanleitung|wundmanagement|python|nursing digest|护理科学|文献|论文|科研|研究|课程|网课)/i),
    dance: summarizeEvidence(notes, /(舞蹈|跳舞|爵士|成品舞|基本功)/i),
    recovery: summarizeEvidence(notes, /(睡|睡眠|夜班|早班|晚班|疲惫|能量|休息|恢复|疼痛)/i),
  };
}

function summarizeEvidence(notes, regex) {
  const positiveDates = [];
  const mentionDates = [];
  for (const note of notes) {
    const lines = String(note.text || "").split(/\r?\n/);
    const mentioned = lines.some((line) => regex.test(line));
    const positive = lines.some((line) => regex.test(line) && lineHasPositiveEvidence(line));
    if (mentioned) {
      mentionDates.push(note.date);
    }
    if (positive) {
      positiveDates.push(note.date);
    }
  }
  return {
    positiveDays: new Set(positiveDates).size,
    mentionDays: new Set(mentionDates).size,
    positiveDates: uniqueSortedDates(positiveDates),
    mentionDates: uniqueSortedDates(mentionDates),
  };
}

function lineHasPositiveEvidence(line) {
  const text = String(line || "").trim();
  if (!text) {
    return false;
  }
  if (/(未完成|没做|沒有做|没有做|没有记录|還沒有|还没有|未记录|放弃|延期|取消|缺席|not done|didn't|did not|no record)/i.test(text)) {
    return false;
  }
  return /(\[x\]|✅|完成|已完成|做了|练了|學了|学了|推进|结束|sport|englisch|english|deutsch|python|praxisanleitung|wundmanagement|nursing digest|运动|健身|有氧操|塑形|骨盆|武当|足弓|基本功|成品舞|跳舞|舞蹈|发音|语法|影子跟读|文献|论文|科研|课程|网课|美容灯)/i.test(text);
}

function identityLine(summary, positiveText, lowText) {
  if (summary.positiveDays > 0) {
    const dates = summary.positiveDates.slice(0, 5).join(", ");
    const more = summary.positiveDates.length > 5 ? "..." : "";
    return `${positiveText}（${summary.positiveDays} 天：${dates}${more}）。`;
  }
  if (summary.mentionDays > 0) {
    return `有相关线索但完成证据不清楚（${summary.mentionDays} 天），先按 unknown 处理。`;
  }
  return lowText;
}

function summarizeWins(wins, limit = 3) {
  if (!wins.length) {
    return ["- Wins Ledger 本期没有新的成功因素记录；哪些条件真正帮到了你仍然是 unknown。"];
  }
  const factorCounts = countBy(wins, (win) => normalizeText(win.success_factor) || "unknown");
  const taskCounts = countBy(wins, (win) => normalizeText(win.task) || "unknown");
  return [
    `- 成功因素记录 ${wins.length} 条：${formatCounts(factorCounts, limit)}。`,
    `- 出现的完成任务：${formatCounts(taskCounts, limit)}。`,
  ];
}

function summarizePatterns(patterns, start, end, limit = 3) {
  const relevant = patterns.filter((pattern) => {
    if (dateInRange(pattern.lastSeenAt, start, end)) {
      return true;
    }
    return Array.isArray(pattern.evidence)
      && pattern.evidence.some((item) => dateInRange(item.date, start, end));
  }).slice(0, limit);
  if (!relevant.length) {
    return ["- 本期没有新的 Pattern Ledger 证据；长期模式保持待观察，不做强结论。"];
  }
  return relevant.map((pattern) => {
    const confidence = Number.isFinite(Number(pattern.confidence))
      ? `confidence ${Number(pattern.confidence).toFixed(2)}`
      : "confidence unknown";
    const hypothesis = normalizeText(pattern.hypothesis) || normalizeText(pattern.summary) || "hypothesis unknown";
    return `- Observation: ${normalizeText(pattern.title) || "未命名模式"}（${normalizeText(pattern.domain) || "unknown"}，${confidence}）。Hypothesis: ${trimForNote(hypothesis)}。`;
  });
}

function summarizeDecisions(decisions, limit = 3) {
  if (!decisions.length) {
    return ["- 本期没有新的 Decision Journal 条目或到期复查决策。"];
  }
  return decisions.slice(0, limit).map((decision) => {
    const title = normalizeText(decision.decision) || normalizeText(decision.context) || "未命名决定";
    const reviewDate = normalizeText(decision.review_date) || "unknown";
    const outcome = normalizeText(decision.later_outcome) ? "已有后续结果" : "等待后续观察";
    return `- ${trimForNote(title)}；复查日：${reviewDate}；状态：${outcome}。`;
  });
}

function chooseSmallestEntry(evidence) {
  const candidates = [
    { score: evidence.sport.positiveDays, priority: 1, text: "运动先回到 10 分钟版本，重点是重新出现，不是一次做满。" },
    { score: evidence.german.positiveDays, priority: 2, text: "德语先做 5-10 分钟影子跟读或语法小块，保护专业沟通这条线。" },
    { score: evidence.english.positiveDays, priority: 3, text: "英语发音先做 5 分钟，继续保护未来阅读国际文献的基础。" },
    { score: evidence.academic.positiveDays, priority: 4, text: "护理科学 / Praxisanleitung 先保留一个 15 分钟阅读或整理入口。" },
    { score: evidence.dance.positiveDays, priority: 5, text: "舞蹈先用一首歌或 10 分钟基本功回来，让身体表达不要断太久。" },
  ];
  candidates.sort((left, right) => left.score - right.score || left.priority - right.priority);
  return candidates[0].text;
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function formatCounts(counts, limit) {
  return counts.slice(0, limit).map(([label, count]) => `${label} ${count}`).join("，") || "unknown";
}

function trimForNote(value, maxLength = 120) {
  const text = normalizeText(value).replace(/\s+/g, " ");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function uniqueSortedDates(dates) {
  return [...new Set(dates.filter(Boolean))].sort();
}

function formatLocalTimestamp(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { PeriodicReviewPipelineService };
