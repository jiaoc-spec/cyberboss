const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_FILE_BYTES = 300_000;
const SOURCE_TYPES = new Set([
  "peer_reviewed_article",
  "guideline",
  "textbook",
  "lecture",
  "clinical_experience",
  "personal_hypothesis",
  "ai_summary",
  "personal_observation",
  "other",
  "unknown",
]);

class KnowledgePortfolioService {
  constructor({ config = {} } = {}) {
    this.config = config;
  }

  audit({ issueLimit = 40 } = {}) {
    const vault = this.resolveVaultDir();
    const root = path.join(vault, this.config.knowledgeFolder || "01. ⚪ Wissenskarte");
    const allNotes = listMarkdownFiles(root).map((filePath) => readKnowledgeNote(filePath, vault)).filter(Boolean);
    const notes = allNotes.filter((note) => !isInboxPath(note.filePath, this.config.knowledgeInboxFolder));
    const titleIndex = buildTitleIndex(allNotes);
    const backlinks = buildBacklinkCounts(allNotes, titleIndex);
    const conceptNotes = notes.filter((note) => note.isConcept);
    const issues = [];
    const sourceTypes = {};
    const themes = {};
    let conceptCount = 0;

    for (const note of conceptNotes) {
      conceptCount += 1;
      const noteIssues = inspectNote(note, { titleIndex, backlinks });
      issues.push(...noteIssues);
      sourceTypes[note.sourceType] = (sourceTypes[note.sourceType] || 0) + 1;
      for (const tag of note.tags) {
        themes[tag] = (themes[tag] || 0) + 1;
      }
    }

    const sortedIssues = issues.sort(compareIssues);
    const qualityScore = conceptCount >= 5
      ? Math.max(0, Math.round(100 - weightedIssueCost(sortedIssues) / conceptCount))
      : null;
    const topThemes = Object.entries(themes)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 12)
      .map(([tag, count]) => ({ tag, count }));

    return {
      generatedAt: new Date().toISOString(),
      root,
      conceptCount,
      mocCount: notes.filter((note) => note.isMoc).length,
      unclassifiedNoteCount: notes.filter((note) => !note.isMoc && !note.isConcept).length,
      qualityStatus: conceptCount >= 5 ? "measured" : "insufficient_sample",
      qualityScore,
      issueCounts: countBy(sortedIssues, (issue) => issue.code),
      severityCounts: countBy(sortedIssues, (issue) => issue.severity),
      sourceTypes,
      topThemes,
      issues: sortedIssues.slice(0, Math.max(1, Math.min(Number(issueLimit) || 40, 200))),
      totalIssues: sortedIssues.length,
      notes: conceptNotes.map((note) => ({
        title: note.title,
        relativePath: note.relativePath,
        created: note.created,
        source: note.source,
        sourceType: note.sourceType,
        tags: note.tags,
        outgoingLinks: note.links.length,
        backlinks: backlinks.get(note.title.toLowerCase()) || 0,
      })),
    };
  }

  buildDashboardMarkdown(audit = null) {
    const result = audit || this.audit({ issueLimit: 12 });
    const themes = result.topThemes.length
      ? result.topThemes.map((item) => `${item.tag} (${item.count})`).join("、")
      : "暂无足够数据";
    const sourceTypes = Object.entries(result.sourceTypes)
      .sort((left, right) => right[1] - left[1])
      .map(([type, count]) => `${type}: ${count}`)
      .join("；") || "暂无";
    const issueLines = result.issues.length
      ? result.issues.slice(0, 12).map((issue) => `- [${issue.severity}] [[${issue.title}]]：${issue.message}`)
      : ["- 当前未发现明显结构问题。"];
    return [
      "## Long-Term Memory Dashboard",
      "",
      `- 概念卡：${result.conceptCount}`,
      `- 知识资产质量：${result.qualityScore === null ? "样本不足（至少 5 张概念卡后开始计算）" : `${result.qualityScore}/100`}`,
      `- 未分类旧笔记：${result.unclassifiedNoteCount}`, 
      `- 当前问题：${result.totalIssues}`,
      `- 活跃主题：${themes}`,
      `- 来源类型：${sourceTypes}`,
      "",
      "### 下一批需要整理",
      ...issueLines,
      "",
      "说明：质量分用于发现知识库维护需求，不用于评价学习表现。来源未知会保留为 unknown，不会由 AI 猜测。",
    ].join("\n");
  }

  resolveVaultDir() {
    return normalizeText(this.config.obsidianVaultDir) || path.join(
      os.homedir(),
      "Library/Mobile Documents/iCloud~md~obsidian/Documents/Jiao's Obsidian",
    );
  }
}

function inspectNote(note, { titleIndex, backlinks }) {
  const issues = [];
  const add = (code, severity, message) => issues.push({
    code,
    severity,
    title: note.title,
    relativePath: note.relativePath,
    message,
  });
  if (!note.source) add("missing_source", "high", "缺少可追溯 source");
  if (!note.sourceType || note.sourceType === "unknown") add("unknown_source_type", "medium", "来源类型为 unknown");
  if (!SOURCE_TYPES.has(note.sourceType)) add("invalid_source_type", "medium", `来源类型不在标准列表：${note.sourceType}`);
  if (!note.tags.length) add("missing_tags", "medium", "缺少主题 tags");
  if (note.bodyLength < 120) add("too_short", "low", "内容过短，可能还没有形成完整概念");
  if (note.bodyLength > 3_500) add("too_long", "low", "内容较长，可能需要拆成更原子的概念卡");
  if (!note.links.length) add("no_outgoing_links", "low", "尚未连接到其他知识卡");
  if ((backlinks.get(note.title.toLowerCase()) || 0) === 0) add("orphan_note", "medium", "没有被知识地图或其他卡片链接");
  for (const link of note.links) {
    if (!titleIndex.has(normalizeLinkTarget(link))) add("broken_link", "high", `链接目标不存在：[[${link}]]`);
  }
  if ((titleIndex.get(note.title.toLowerCase()) || []).length > 1) add("duplicate_title", "medium", "存在同名概念卡，需要人工判断是否合并");
  return issues;
}

function readKnowledgeNote(filePath, vault) {
  try {
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) return null;
    const text = fs.readFileSync(filePath, "utf8");
    const frontmatter = parseFrontmatter(text);
    const body = stripFrontmatter(text);
    const title = path.basename(filePath, ".md");
    return {
      filePath,
      relativePath: path.relative(vault, filePath).split(path.sep).join("/"),
      title,
      isMoc: title.startsWith("00."),
      type: normalizeText(frontmatter.type).toLowerCase(),
      isConcept: normalizeText(frontmatter.type).toLowerCase() === "concept",
      created: normalizeText(frontmatter.created),
      source: normalizeText(frontmatter.source),
      sourceType: normalizeText(frontmatter.source_type).toLowerCase() || "unknown",
      tags: parseTags(frontmatter.tags),
      links: [...body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((match) => match[1].trim()).filter(Boolean),
      bodyLength: body.replace(/\s+/g, " ").trim().length,
    };
  } catch {
    return null;
  }
}

function buildTitleIndex(notes) {
  const index = new Map();
  for (const note of notes) {
    const key = note.title.toLowerCase();
    const existing = index.get(key) || [];
    existing.push(note.relativePath);
    index.set(key, existing);
  }
  return index;
}

function buildBacklinkCounts(notes, titleIndex) {
  const counts = new Map();
  for (const note of notes) {
    for (const link of note.links) {
      const key = normalizeLinkTarget(link);
      if (titleIndex.has(key)) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function normalizeLinkTarget(link) {
  return path.basename(normalizeText(link), ".md").toLowerCase();
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field) result[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function parseTags(value) {
  const text = normalizeText(value).replace(/^\[|\]$/g, "");
  return [...new Set(text.split(/[,，]/).map((tag) => tag.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean))];
}

function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
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

function isInboxPath(filePath, inboxFolder) {
  const configured = normalizeText(inboxFolder);
  return /Knowledge Inbox/i.test(filePath) || (configured && filePath.includes(configured));
}

function weightedIssueCost(issues) {
  const weights = { high: 14, medium: 7, low: 3 };
  return issues.reduce((sum, issue) => sum + (weights[issue.severity] || 1), 0);
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function compareIssues(left, right) {
  const rank = { high: 0, medium: 1, low: 2 };
  return (rank[left.severity] ?? 9) - (rank[right.severity] ?? 9)
    || left.title.localeCompare(right.title)
    || left.code.localeCompare(right.code);
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

module.exports = {
  KnowledgePortfolioService,
  SOURCE_TYPES,
};
