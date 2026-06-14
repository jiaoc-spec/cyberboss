const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { ObsidianNoteService } = require("./obsidian-note-service");

const MAX_CANDIDATES = 6;
const STATE_RETENTION_DAYS = 90;

// Digestion pipeline: fights the collector's fallacy. Captured raw notes pile
// up in the Knowledge Inbox + Notizen; left alone they are just hoarded, never
// understood. Once a week the bridge proposes which raw notes are worth
// promoting into atomic concept notes in the Wissenskarte (suggest-first), and
// only writes after Jane picks. The model does the actual promotion + MOC
// update via the no-approval obsidian note tools.
class DigestionService {
  constructor({ config, channelAdapter, sessionStore, systemMessageQueue }) {
    this.config = config || {};
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.systemMessageQueue = systemMessageQueue;
    this.stateFile = this.config.digestionStateFile;
    this.obsidianNote = new ObsidianNoteService({ config: this.config });
    this.lastCheckAtMs = 0;
  }

  async check(account, now = new Date()) {
    if (this.config.digestionEnabled === false || !this.systemMessageQueue || !this.channelAdapter) {
      return { offered: false };
    }
    const intervalMs = this.config.digestionCheckIntervalMs || 1_800_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { offered: false };
    }
    this.lastCheckAtMs = now.getTime();

    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const local = localParts(now, timeZone);
    // Sunday evening, after the weekly review has had its slot.
    if (local.weekday !== 7 || local.hour < (this.config.digestionHour ?? 21)) {
      return { offered: false };
    }

    const weekKey = isoWeekKey(local.date);
    const state = this.loadState();
    if (state.offers[weekKey]) {
      return { offered: false, reason: "already_offered" };
    }
    if (this.systemMessageQueue.hasPendingForAccount(account.accountId)) {
      return { offered: false, reason: "queue_busy" };
    }

    const candidates = this.scanCandidates(local.date, state);
    if (!candidates.length) {
      state.offers[weekKey] = { offeredAt: now.toISOString(), candidates: [], status: "empty" };
      this.saveState(state);
      return { offered: false, reason: "no_candidates" };
    }

    const target = this.resolveTarget(account);
    if (!target.senderId) {
      return { offered: false, reason: "no_target" };
    }

    await this.channelAdapter.sendText({
      userId: target.senderId,
      text: buildOfferMessage(candidates, this.config),
      contextToken: this.channelAdapter.getKnownContextTokens?.()[target.senderId] || target.senderId,
    });

    state.offers[weekKey] = { offeredAt: now.toISOString(), candidates, status: "offered" };
    state.pendingOffer = {
      weekKey,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      offeredAt: now.toISOString(),
      candidates,
    };
    state.offers = pruneByWeek(state.offers, local.date);
    this.saveState(state);
    console.log(`[cyberboss] digestion offered week=${weekKey} candidates=${candidates.length}`);
    return { offered: true, weekKey, count: candidates.length };
  }

  // Bridge intercept: Jane's reply to a pending digestion offer (e.g. "1 3",
  // 全部, 跳过) is consumed here and turned into a focused promotion trigger.
  handleReply(text = "", now = new Date()) {
    const state = this.loadState();
    const pending = state.pendingOffer;
    if (!pending) {
      return null;
    }
    const ageMs = now.getTime() - Date.parse(pending.offeredAt);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 48 * 3_600_000) {
      delete state.pendingOffer;
      this.saveState(state);
      return null;
    }
    const decision = parseDigestionReply(text, pending.candidates.length);
    if (!decision) {
      return null;
    }

    if (decision.skip) {
      for (const c of pending.candidates) {
        state.dismissed[c.path] = now.toISOString();
      }
      delete state.pendingOffer;
      state.dismissed = pruneByDate(state.dismissed, now);
      this.saveState(state);
      return { action: "skip" };
    }

    const chosen = decision.indices
      .map((n) => pending.candidates[n - 1])
      .filter(Boolean);
    if (!chosen.length) {
      return null;
    }
    for (const c of chosen) {
      state.promoted[c.path] = now.toISOString();
    }
    delete state.pendingOffer;
    state.promoted = pruneByDate(state.promoted, now);
    this.saveState(state);
    return {
      action: "promote",
      chosen,
      senderId: pending.senderId,
      workspaceRoot: pending.workspaceRoot,
    };
  }

  // Local bridge fallback: Jane has explicitly chosen the notes. The bridge
  // should guarantee a durable draft even if the model/tool turn fails later.
  async promoteLocally(chosen = [], now = new Date()) {
    const dateText = localParts(now, this.config.timeZone || this.config.diaryTimeZone || "UTC").date;
    const promoted = [];
    const failures = [];
    for (const candidate of chosen) {
      try {
        const sourcePath = String(candidate?.path || "");
        if (!sourcePath || !fs.existsSync(sourcePath)) {
          throw new Error("source note not found");
        }
        const rawText = fs.readFileSync(sourcePath, "utf8");
        const sourceTitle = normalizeTitle(candidate?.title || path.basename(sourcePath, ".md"));
        const conceptTitle = normalizeConceptTitle(sourceTitle);
        const relativePath = this.uniqueConceptRelativePath(conceptTitle);
        const sourceRelativePath = vaultRelativePath(sourcePath, this.resolveVaultDir());
        const content = buildLocalConceptContent({
          conceptTitle,
          sourceTitle,
          sourceRelativePath,
          rawText,
          dateText,
        });
        const written = await this.obsidianNote.write({ relativePath, content, mode: "append" });
        promoted.push({
          title: conceptTitle,
          sourceTitle,
          relativePath: written.relativePath,
          filePath: written.filePath,
          sourceRelativePath,
        });
      } catch (error) {
        failures.push({
          title: candidate?.title || "",
          path: candidate?.path || "",
          error: error?.message || String(error),
        });
      }
    }
    if (promoted.length) {
      await this.appendMocLinks(promoted);
    }
    return { promoted, failures };
  }

  uniqueConceptRelativePath(conceptTitle) {
    const folder = this.config.knowledgeFolder || "01. ⚪ Wissenskarte";
    const base = safeFileStem(conceptTitle) || "未命名概念";
    const vault = this.resolveVaultDir();
    for (let index = 1; index <= 99; index += 1) {
      const stem = index === 1 ? base : `${base}-${index}`;
      const relativePath = `${folder}/${stem}.md`;
      if (!fs.existsSync(path.join(vault, relativePath))) {
        return relativePath;
      }
    }
    return `${folder}/${base}-${Date.now()}.md`;
  }

  async appendMocLinks(promoted) {
    const knowledgeFolder = this.config.knowledgeFolder || "01. ⚪ Wissenskarte";
    const mocRelativePath = `${knowledgeFolder}/00. 知识地图.md`;
    const existing = await this.obsidianNote.read({ relativePath: mocRelativePath }).catch(() => ({ exists: false, text: "" }));
    const lines = [];
    if (!/##\s*待整理概念卡/.test(existing.text || "")) {
      lines.push("## 待整理概念卡", "");
    }
    for (const item of promoted) {
      const link = `[[${path.basename(item.relativePath, ".md")}]]`;
      if (!String(existing.text || "").includes(link)) {
        lines.push(`- ${link}（source: [[${item.sourceTitle}]])`);
      }
    }
    if (lines.length) {
      await this.obsidianNote.write({
        relativePath: mocRelativePath,
        content: lines.join("\n"),
        mode: "append",
      });
    }
  }

  scanCandidates(todayDate, state) {
    const vault = this.resolveVaultDir();
    const inboxDir = path.join(vault, this.config.knowledgeInboxFolder || "");
    const notizenDir = path.join(vault, this.config.notizenFolder || "02. 🟡 Notizen");
    const seen = new Set([...Object.keys(state.promoted), ...Object.keys(state.dismissed)]);
    const out = [];

    for (const name of listMd(inboxDir)) {
      const filePath = path.join(inboxDir, name);
      if (seen.has(filePath)) continue;
      out.push({ path: filePath, title: name.replace(/\.md$/, ""), source: "inbox" });
    }
    const recentCutoff = Date.parse(`${addDaysText(todayDate, -7)}T00:00:00Z`);
    for (const name of listMd(notizenDir)) {
      const filePath = path.join(notizenDir, name);
      if (seen.has(filePath)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(filePath).mtimeMs; } catch { continue; }
      if (mtime < recentCutoff) continue;
      out.push({ path: filePath, title: name.replace(/\.md$/, ""), source: "notizen" });
    }
    return out.slice(0, MAX_CANDIDATES).map((c, i) => ({ n: i + 1, ...c }));
  }

  resolveVaultDir() {
    const configured = String(this.config.obsidianVaultDir || "").trim();
    if (configured) return configured;
    return path.join(os.homedir(), "Library/Mobile Documents/iCloud~md~obsidian/Documents/Jiao's Obsidian");
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
        offers: obj(parsed?.offers),
        promoted: obj(parsed?.promoted),
        dismissed: obj(parsed?.dismissed),
        pendingOffer: parsed?.pendingOffer && typeof parsed.pendingOffer === "object" ? parsed.pendingOffer : null,
      };
    } catch {
      return { offers: {}, promoted: {}, dismissed: {}, pendingOffer: null };
    }
  }

  saveState(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function buildOfferMessage(candidates, config = {}) {
  const userName = String(config.userName || "你").trim();
  const lines = [
    `${userName}，这周有几条笔记可以升级成概念卡（沉淀进知识卡区，连到相关旧笔记）：`,
    "",
    ...candidates.map((c) => `${c.n}. ${c.title}`),
    "",
    "回复「升级 1 3」选择要升级的条目，也可以回「全部升级」/「跳过」。只回「1 3」也可以；不回就下周再说。",
  ];
  return lines.join("\n");
}

function buildPromotionTrigger(chosen, config = {}) {
  const knowledgeFolder = config.knowledgeFolder || "01. ⚪ Wissenskarte";
  const mocPath = `${knowledgeFolder}/00. 知识地图.md`;
  return [
    "[DIGESTION PROMOTION] [COMPLEX_TASK requires_tools=true no_deepseek_fallback=true]",
    "如果你是 DeepSeek fallback，请直接回复 {\"action\":\"silent\"}。",
    "",
    `把下面这几条原始笔记升级成原子概念笔记，写进 ${knowledgeFolder}/：`,
    ...chosen.map((c) => `- ${c.path}`),
    "",
    "对每一条：",
    "- 用 cyberboss_obsidian_note_read 读原文。",
    "- 提炼成一篇原子概念笔记（一篇只讲一个概念），用 cyberboss_obsidian_note_write 写进知识卡区，文件名用简洁的概念名。",
    "- frontmatter 必须含：created（日期）、type: concept、tags（含学科标签，如 Pflegewissenschaft/Deutsch/Python/文献 等，方便日后主动回忆只挑学术内容）、source（原始笔记名）。",
    "- 正文：一句话核心 + 展开 + 用 [[ ]] 连到 1-3 篇相关已有笔记（先 cyberboss_obsidian_note_read 或 cyberboss_knowledge_search 确认存在再连）。",
    `- 然后用 cyberboss_obsidian_note_write 以 mode=append 更新知识地图 ${mocPath}：在对应主题分区下加一行 [[概念笔记名]]。`,
    "",
    "原则：宁缺毋滥，概念要真的成立；不要把生活流水账硬升级成知识。完成后用一句话告诉她升级了哪几条、连到了什么。",
    "Return send_message, not silent.",
  ].join("\n");
}

function buildLocalConceptContent({ conceptTitle, sourceTitle, sourceRelativePath, rawText, dateText }) {
  const excerpt = trimForNote(stripFrontmatter(rawText), 1200);
  return [
    "---",
    `created: ${dateText}`,
    "type: concept",
    "status: draft",
    "tags: [self-observation, behavior-design]",
    `source: ${yamlQuote(sourceTitle)}`,
    `source_path: ${yamlQuote(sourceRelativePath)}`,
    "generated_by: cyberboss_digest_bridge_fallback",
    "---",
    "",
    `# ${conceptTitle}`,
    "",
    "## 一句话核心",
    `${conceptTitle} 是一条值得继续观察的个人模式。当前版本先作为概念卡草稿保存，后续可以在周/月复盘中继续打磨。`,
    "",
    "## 原始证据",
    quoteBlock(excerpt || "(原始笔记为空)"),
    "",
    "## 观察",
    "- 这是从原始笔记升级而来的初始观察，先作为证据保存，不直接当作结论。",
    "- 后续需要结合更多日期、身体状态、习惯完成情况和环境线索再判断它是否稳定。",
    "",
    "## 可继续验证",
    "- 未来几周观察这个模式是否反复出现。",
    "- 如果它和运动、塑形、学习启动或恢复状态有关，可以在 Weekly / Monthly Review 中升级为更稳定的 Pattern。",
    "",
    "## 来源",
    `- [[${sourceTitle}]]`,
  ].join("\n");
}

function parseDigestionReply(text, count) {
  let body = String(text || "").trim();
  if (!body || body.length > 40) return null;
  body = body.replace(/^(升级|知识|消化)\s*/i, "").trim();
  if (/^(跳过|skip|算了|不用|pass)$/i.test(body)) {
    return { skip: true };
  }
  if (/^(全部|全部升级|all|都要|全要)$/i.test(body)) {
    return { indices: Array.from({ length: count }, (_, i) => i + 1) };
  }
  const nums = body.match(/\d+/g);
  if (!nums) return null;
  const indices = [...new Set(nums.map(Number).filter((n) => n >= 1 && n <= count))];
  if (!indices.length) return null;
  return { indices };
}

function normalizeConceptTitle(title) {
  return normalizeTitle(title)
    .replace(/^\d{4}-\d{2}-\d{2}\s+/, "")
    .replace(/^Knowledge Inbox\s*[-_]\s*/i, "")
    .trim()
    || "未命名概念";
}

function normalizeTitle(value) {
  return String(value || "").trim().replace(/\.md$/i, "");
}

function safeFileStem(title) {
  return normalizeConceptTitle(title)
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function vaultRelativePath(filePath, vaultDir) {
  const relative = path.relative(vaultDir, filePath);
  return relative && !relative.startsWith("..")
    ? relative.split(path.sep).join("/")
    : filePath;
}

function stripFrontmatter(text) {
  return String(text || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function trimForNote(text, maxLength) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function quoteBlock(text) {
  return String(text || "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function yamlQuote(value) {
  return JSON.stringify(String(value || ""));
}

function listMd(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".md") && !name.startsWith("00.") && !name.startsWith("."));
  } catch {
    return [];
  }
}

function obj(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function pruneByWeek(offers, currentDate) {
  const cutoff = isoWeekKey(addDaysText(currentDate, -7 * 12));
  return Object.fromEntries(Object.entries(offers).filter(([week]) => week >= cutoff));
}

function pruneByDate(map, now) {
  const cutoffMs = now.getTime() - STATE_RETENTION_DAYS * 86_400_000;
  return Object.fromEntries(Object.entries(map).filter(([, at]) => {
    const parsed = Date.parse(at);
    return Number.isFinite(parsed) && parsed >= cutoffMs;
  }));
}

function isoWeekKey(dateText) {
  const date = new Date(`${dateText}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
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
    weekday: "short",
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[parts.weekday] || 0,
  };
}

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

module.exports = { DigestionService, buildPromotionTrigger, parseDigestionReply, buildOfferMessage };
