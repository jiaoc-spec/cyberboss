const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_FILE_BYTES = 240_000;
const MAX_FILES_SCANNED = 1_500;
const RECALL_INTENT = /(正在|我在|我要|我想|准备|开始|继续|复习|整理|写|做|研究|思考|纠结|决定|规划|设计|备课|作业|论文|报告|演讲|研究问题|hausarbeit|seminar|bachelorarbeit|masterarbeit|paper|draft|outline|argument)/i;
const EXPLICIT_RECALL = /(之前|以前|过去|相关笔记|相关内容|我的笔记|我记得|回顾|召回|recall|notes?)/i;
const DOMAIN_TERMS = [
  "trauma-informed care", "trauma informed care", "pflegewissenschaft", "praxisanleitung",
  "wundmanagement", "forensik", "akutpsychiatrie", "beziehungsgestaltung", "python",
  "nursing digest", "pflege", "nursing", "deutsch", "englisch", "research", "forschung",
  "护理科学", "精神科护理", "创伤知情", "实践指导", "伤口管理", "德语", "英语",
  "夜班", "轮班", "睡眠", "恢复", "运动", "科研", "研究", "教学", "论文", "文献",
];
const STOPWORDS = new Set([
  "jane", "cyberboss", "今天", "现在", "这个", "那个", "一些", "一个", "一下", "怎么",
  "什么", "可以", "需要", "帮我", "我在", "我要", "我想", "准备", "开始", "继续", "正在",
  "the", "and", "for", "with", "from", "this", "that", "into", "about", "mein", "eine", "einen",
]);

class InsightRecallService {
  constructor({ config = {} } = {}) {
    this.config = config;
  }

  buildContext({ text = "", limit = 0 } = {}) {
    const body = normalizeText(text);
    if (this.config.insightRecallEnabled === false || !shouldRecall(body)) {
      return { triggered: false, terms: [], items: [], text: "" };
    }
    const terms = extractTerms(body);
    if (!terms.length) {
      return { triggered: false, terms: [], items: [], text: "" };
    }
    const safeLimit = Number.isInteger(limit) && limit > 0
      ? Math.min(limit, 6)
      : Math.min(Math.max(1, Number(this.config.insightRecallMaxResults) || 3), 6);
    const items = [
      ...this.searchVault(terms),
      ...this.searchLedgers(terms),
    ]
      .sort(compareCandidates)
      .filter(uniqueCandidate())
      .slice(0, safeLimit);

    return {
      triggered: items.length > 0,
      terms,
      items,
      text: items.length ? formatRecallContext(items, terms) : "",
    };
  }

  searchVault(terms) {
    const vault = this.resolveVaultDir();
    const roots = [
      [path.join(vault, this.config.knowledgeFolder || "01. ⚪ Wissenskarte"), "academic_note"],
      [path.join(vault, this.config.notizenFolder || "02. 🟡 Notizen"), "note"],
      [path.join(vault, this.config.obsidianWeeklyFolder || "03. 🔵 Tagebuch/02. 周记"), "weekly_review"],
      [path.join(vault, this.config.obsidianMonthlyFolder || "03. 🔵 Tagebuch/03. 月记"), "monthly_review"],
    ];
    const candidates = [];
    let scanned = 0;
    for (const [root, evidenceType] of roots) {
      for (const filePath of listMarkdownFiles(root)) {
        scanned += 1;
        if (scanned > MAX_FILES_SCANNED) return candidates;
        const raw = readFileCapped(filePath);
        if (!raw) continue;
        const name = path.basename(filePath, ".md");
        const frontmatter = parseFrontmatter(raw);
        const titleText = `${name} ${frontmatter.tags || ""} ${frontmatter.source || ""}`.toLowerCase();
        const bodyText = stripFrontmatter(raw).toLowerCase();
        const score = scoreText({ titleText, bodyText, terms });
        if (score <= 0) continue;
        candidates.push({
          id: filePath,
          evidenceType,
          title: name,
          source: frontmatter.source || path.relative(vault, filePath),
          sourceType: frontmatter.source_type || "unknown",
          score,
          excerpt: bestExcerpt(stripFrontmatter(raw), terms),
          path: path.relative(vault, filePath).split(path.sep).join("/"),
        });
      }
    }
    return candidates;
  }

  searchLedgers(terms) {
    return [
      ...searchJsonArray(this.config.patternLedgerFile, "patterns", terms, "personal_pattern", (item) => ({
        title: item.title,
        source: item.status || "pattern-ledger",
        sourceType: "personal_observation",
        excerpt: [item.summary, item.hypothesis, item.supportStrategy].filter(Boolean).join(" "),
      })),
      ...searchJsonArray(this.config.experienceLedgerFile, "experiences", terms, "reusable_experience", (item) => ({
        title: item.title || item.theme || item.lesson,
        source: item.date || item.source || "experience-ledger",
        sourceType: item.type || "personal_experience",
        excerpt: [item.situation, item.lesson, item.nextAction].filter(Boolean).join(" "),
      })),
      ...searchJsonArray(this.config.experienceLedgerFile, "guides", terms, "action_guide", (item) => ({
        title: item.title || item.theme,
        source: item.status || "experience-ledger",
        sourceType: "personal_action_guide",
        excerpt: [item.trigger, item.defaultAction, item.minimumVersion, item.notToDo].filter(Boolean).join(" "),
      })),
      ...searchJsonArray(this.config.decisionJournalFile, "decisions", terms, "past_decision", (item) => ({
        title: item.decision,
        source: item.date || "decision-journal",
        sourceType: "personal_decision",
        excerpt: [item.context, item.reasons, item.later_outcome, item.reflection].filter(Boolean).join(" "),
      })),
      ...searchJsonArray(this.config.researchLedgerFile, "items", terms, "research_asset", (item) => ({
        title: item.title,
        source: item.link || item.date || "research-ledger",
        sourceType: item.type || "research_asset",
        excerpt: item.note || "",
      })),
      ...searchJsonArray(this.config.campaignsFile, "campaigns", terms, "active_project", (item) => ({
        title: item.name,
        source: item.status || "campaign",
        sourceType: item.kind || "project",
        excerpt: [item.note, item.nextAction, ...(item.outputs || []).map((output) => output.title || output)].filter(Boolean).join(" "),
      })),
    ];
  }

  resolveVaultDir() {
    return normalizeText(this.config.obsidianVaultDir) || path.join(
      os.homedir(),
      "Library/Mobile Documents/iCloud~md~obsidian/Documents/Jiao's Obsidian",
    );
  }
}

function shouldRecall(text) {
  if (!text || text.length < 4) return false;
  return EXPLICIT_RECALL.test(text) || RECALL_INTENT.test(text);
}

function extractTerms(text) {
  const lowered = text.toLowerCase();
  const terms = [];
  for (const term of DOMAIN_TERMS) {
    if (lowered.includes(term.toLowerCase())) terms.push(term.toLowerCase());
  }
  if (lowered.includes("夜班")) terms.push("night shift", "night-shift", "nachtdienst");
  if (lowered.includes("学习")) terms.push("learning", "study");
  if (lowered.includes("护理科学")) terms.push("pflegewissenschaft", "nursing science");
  if (lowered.includes("研究")) terms.push("research", "forschung");
  for (const match of lowered.matchAll(/[a-zäöüß][a-z0-9äöüß'_-]{2,}/gi)) {
    const term = match[0].toLowerCase();
    if (!STOPWORDS.has(term)) terms.push(term);
  }
  const chunks = lowered
    .replace(/[a-z0-9äöüß'_-]+/gi, " ")
    .split(/[\s，。！？；：、,.!?;:()（）【】\[\]"“”]+/)
    .map((chunk) => chunk.replace(/^(我在|我要|我想|准备|开始|继续|正在|帮我|关于)/, "").trim())
    .filter((chunk) => chunk.length >= 2 && chunk.length <= 12 && !STOPWORDS.has(chunk));
  terms.push(...chunks);
  return [...new Set(terms)].slice(0, 12);
}

function searchJsonArray(filePath, key, terms, evidenceType, project) {
  const normalized = normalizeText(filePath);
  if (!normalized) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(normalized, "utf8"));
    const items = Array.isArray(parsed?.[key]) ? parsed[key] : [];
    return items.map((item) => {
      const projected = project(item) || {};
      const haystack = JSON.stringify(item).toLowerCase();
      const score = scoreTerms(haystack, terms) * 2;
      if (score <= 0) return null;
      return {
        id: `${evidenceType}:${item.id || projected.title}`,
        evidenceType,
        title: normalizeText(projected.title) || "Untitled",
        source: normalizeText(projected.source) || evidenceType,
        sourceType: normalizeText(projected.sourceType) || "unknown",
        excerpt: trimText(projected.excerpt, 260),
        path: normalized,
        score,
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function scoreText({ titleText, bodyText, terms }) {
  let score = 0;
  for (const term of terms) {
    if (titleText.includes(term)) score += 8;
    if (bodyText.includes(term)) score += 2;
  }
  return score;
}

function scoreTerms(text, terms) {
  return terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
}

function bestExcerpt(text, terms) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const lowered = normalized.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const candidate = lowered.indexOf(term);
    if (candidate >= 0 && (index < 0 || candidate < index)) index = candidate;
  }
  if (index < 0) return trimText(normalized, 240);
  return trimText(normalized.slice(Math.max(0, index - 70), index + 220), 260);
}

function formatRecallContext(items, terms) {
  return [
    `Just-in-time Insight Recall matched: ${terms.join(", ")}`,
    "Use these only when they help the user's current real task. Do not announce a database search and do not force every item into the reply.",
    "Keep evidence types separate: academic notes/sources are not the same as reusable personal experience, action guides, personal patterns, hypotheses, or past decisions.",
    ...items.map((item, index) => [
      `${index + 1}. [${item.evidenceType}] ${item.title}`,
      `   source_type=${item.sourceType}; source=${item.source}`,
      item.excerpt ? `   ${item.excerpt}` : "",
      item.path ? `   path=${item.path}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function listMarkdownFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) out.push(...listMarkdownFiles(full));
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function readFileCapped(filePath) {
  try {
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field) result[field[1]] = field[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return result;
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function uniqueCandidate() {
  const seen = new Set();
  return (item) => {
    const key = `${item.evidenceType}:${item.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function compareCandidates(left, right) {
  return right.score - left.score || left.title.localeCompare(right.title);
}

function trimText(value, max) {
  const text = normalizeText(value);
  return text.length <= max ? text : `${text.slice(0, max - 3).trim()}...`;
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

module.exports = {
  InsightRecallService,
  extractTerms,
  shouldRecall,
};
