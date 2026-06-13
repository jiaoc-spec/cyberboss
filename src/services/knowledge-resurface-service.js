const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");

const RESURFACE_INTERVALS_DAYS = [7, 30];
const STATE_RETENTION_DAYS = 60;

// Academic recall only (Jane's choice): a note is eligible if its frontmatter
// tags or its folder mark it as study/exam/research material. Life/self-
// observation captures are NOT turned into quiz questions - they just rest.
const DEFAULT_ACADEMIC_TAGS = [
  "pflegewissenschaft", "护理科学", "护理", "nursing",
  "deutsch", "德语", "german",
  "englisch", "英语", "english",
  "python", "statistik", "统计", "数据",
  "wundmanagement", "伤口", "praxisanleitung",
  "literature", "文献", "论文", "research", "科研", "forschung",
  "concept", "klausur", "exam", "考试", "pflegeausbildung",
];

// Spaced resurfacing as retrieval practice: an academic concept note comes
// back 7 and 30 days later, in the evening, at most one per day - but as a
// question first (active recall beats re-reading), then the source for
// self-check. Reads concept notes in the Wissenskarte plus the inbox.
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

  academicTags() {
    const custom = Array.isArray(this.config.knowledgeRecallAcademicTags)
      ? this.config.knowledgeRecallAcademicTags
      : [];
    return [...DEFAULT_ACADEMIC_TAGS, ...custom].map((t) => String(t).toLowerCase());
  }

  findDueNote(todayDate, state) {
    const vault = this.resolveVaultDir();
    const dirs = [
      path.join(vault, this.config.knowledgeFolder || "01. ⚪ Wissenskarte"),
      path.join(vault, this.config.knowledgeInboxFolder || ""),
    ].filter(Boolean);
    const academic = this.academicTags();
    const files = [];
    for (const dir of dirs) {
      for (const filePath of listMarkdownFiles(dir)) {
        files.push(filePath);
      }
    }
    for (const intervalDays of RESURFACE_INTERVALS_DAYS) {
      const targetCreated = addDaysText(todayDate, -intervalDays);
      for (const filePath of files) {
        const created = readCreatedDate(filePath);
        if (created !== targetCreated) {
          continue;
        }
        if (!isAcademicNote(filePath, vault, academic)) {
          continue;
        }
        const name = path.basename(filePath).replace(/\.md$/, "");
        const key = `${name}:${intervalDays}`;
        if (state.resurfaced[key]) {
          continue;
        }
        return {
          key,
          name,
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
    "Active recall (academic): DELIVERY REQUIRED.",
    `${candidate.intervalDays} 天前（${candidate.createdDate}）${userName} 学过/记过一个概念：《${candidate.name}》`,
    candidate.excerpt ? `（内部参考，先别直接发给她）笔记内容：${candidate.excerpt}` : "",
    `完整笔记在：${candidate.filePath}`,
    "用一条很短、很自然的消息，问她一个能勾起主动回忆的小问题——让她先自己想起这个概念是什么/为什么/怎么用（提取练习对记忆远比重读有效）。",
    "不要把答案直接塞给她，那样就退回成重读了。等她回答后，再用一句话给原文对照、补全或纠正。",
    "语气像一个一起复习的朋友，不是考官，不要说'根据间隔重复原理'，不要超过两三句。她现在不想答也完全没关系。",
    "Return send_message, not silent.",
  ].filter(Boolean).join("\n");
}

function isAcademicNote(filePath, vaultDir, academicTags) {
  const folderHit = /Wissenskarte|Pflegeausbildung|Notizen/i.test(path.relative(vaultDir, filePath));
  const tags = readFrontmatterTags(filePath);
  const tagHit = tags.some((tag) => academicTags.includes(tag.toLowerCase()));
  // A bare inbox capture with no tags is a life note by default; only promote
  // to recall if it carries an academic tag or sits in a study folder.
  if (tagHit) return true;
  if (folderHit && /Pflegeausbildung/i.test(path.relative(vaultDir, filePath))) return true;
  if (tags.length === 0) return false;
  return false;
}

function readFrontmatterTags(filePath) {
  try {
    const head = fs.readFileSync(filePath, "utf8").slice(0, 600);
    const fm = /^---\n([\s\S]*?)\n---/.exec(head);
    if (!fm) return [];
    const line = /^tags:\s*(.+)$/m.exec(fm[1]);
    if (!line) return [];
    return line[1]
      .replace(/[[\]]/g, "")
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listMarkdownFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      out.push(...listMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("00.")) {
      out.push(full);
    }
  }
  return out;
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
