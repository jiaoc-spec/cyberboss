const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_SEARCH_FILE_BYTES = 200_000;
const MAX_RELATED_NOTES = 5;

// Knowledge Inbox: turns a throwaway Telegram message ("这篇 RCT 的结论很反直觉…")
// into a durable, linked note inside the Obsidian Wissenskarte, so learning
// compounds instead of scrolling away.
class KnowledgeService {
  constructor({ config } = {}) {
    this.config = config || {};
  }

  async capture({ title = "", content = "", tags = [], source = "", sourceType = "", evidenceStatus = "", date = "" } = {}) {
    const normalizedTitle = normalizeText(title);
    const normalizedContent = normalizeText(content);
    if (!normalizedTitle) {
      throw new Error("knowledge_capture: title is required.");
    }
    if (!normalizedContent) {
      throw new Error("knowledge_capture: content is required.");
    }
    const vaultDir = this.resolveVaultDir();
    const inboxDir = path.join(vaultDir, this.config.knowledgeInboxFolder || "00. Knowledge Inbox");
    const dateText = normalizeText(date) || formatDate(new Date(), this.timeZone());
    const slug = buildSlug(normalizedTitle);
    const filePath = uniquePath(path.join(inboxDir, `${dateText} ${slug}.md`));
    const normalizedTags = [...new Set((Array.isArray(tags) ? tags : []).map(normalizeText).filter(Boolean))];
    const related = this.findRelatedNotes([normalizedTitle, ...normalizedTags], filePath);

    const lines = [
      "---",
      `created: ${dateText}`,
      `source: ${yamlQuote(normalizeText(source) || "unknown")}`,
      `source_type: ${normalizeSourceType(sourceType)}`,
      `evidence_status: ${normalizeEvidenceStatus(evidenceStatus)}`,
      "capture_channel: telegram",
      `tags: [${normalizedTags.join(", ")}]`,
      "---",
      "",
      `# ${normalizedTitle}`,
      "",
      normalizedContent,
    ];
    if (related.length) {
      lines.push("", "## 相关笔记", ...related.map((note) => `- [[${note.name}]]`));
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
    return {
      filePath,
      title: normalizedTitle,
      tags: normalizedTags,
      relatedNotes: related.map((note) => note.name),
    };
  }

  async search({ query = "", limit = 8 } = {}) {
    const normalizedQuery = normalizeText(query).toLowerCase();
    if (!normalizedQuery) {
      throw new Error("knowledge_search: query is required.");
    }
    const vaultDir = this.resolveVaultDir();
    const roots = this.searchRoots(vaultDir);
    const results = [];
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 25) : 8;
    for (const root of roots) {
      for (const filePath of listMarkdownFiles(root)) {
        const name = path.basename(filePath, ".md");
        const nameHit = name.toLowerCase().includes(normalizedQuery);
        let snippet = "";
        if (!nameHit) {
          const text = readFileCapped(filePath);
          const index = text.toLowerCase().indexOf(normalizedQuery);
          if (index < 0) {
            continue;
          }
          snippet = text.slice(Math.max(0, index - 60), index + 120).replace(/\s+/g, " ").trim();
        }
        results.push({ name, filePath, match: nameHit ? "title" : "content", snippet });
        if (results.length >= safeLimit) {
          return { query, results, truncated: true };
        }
      }
    }
    return { query, results, truncated: false };
  }

  findRelatedNotes(keywords, excludePath = "") {
    try {
      const vaultDir = this.resolveVaultDir();
      const roots = this.searchRoots(vaultDir);
      const terms = [...new Set(
        keywords
          .flatMap((keyword) => splitKeyword(keyword))
          .filter((term) => term.length >= 2),
      )];
      if (!terms.length) {
        return [];
      }
      const scored = [];
      for (const root of roots) {
        for (const filePath of listMarkdownFiles(root)) {
          if (filePath === excludePath) continue;
          const name = path.basename(filePath, ".md");
          const lowered = name.toLowerCase();
          const score = terms.reduce((sum, term) => (lowered.includes(term.toLowerCase()) ? sum + 1 : sum), 0);
          if (score > 0) {
            scored.push({ name, filePath, score });
          }
        }
      }
      scored.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
      return scored.slice(0, MAX_RELATED_NOTES);
    } catch {
      return [];
    }
  }

  searchRoots(vaultDir) {
    const roots = [
      path.join(vaultDir, this.config.knowledgeFolder || "01. ⚪ Wissenskarte"),
      path.join(vaultDir, "02. 🟡 Notizen"),
    ];
    return roots.filter((root) => fs.existsSync(root));
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

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }
}

function listMarkdownFiles(dir) {
  const files = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      files.push(...listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function readFileCapped(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SEARCH_FILE_BYTES) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function splitKeyword(keyword) {
  const normalized = normalizeText(keyword);
  if (!normalized) {
    return [];
  }
  const parts = normalized.split(/[\s,;:：，、/()（）\[\]【】"'`#]+/).filter(Boolean);
  return parts.length ? parts : [normalized];
}

function buildSlug(title) {
  return title
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let index = 2; index < 100; index += 1) {
    const candidate = path.join(dir, `${base} ${index}${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(dir, `${base} ${Date.now()}${ext}`);
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeSourceType(value) {
  const normalized = normalizeText(value).toLowerCase();
  const allowed = new Set([
    "peer_reviewed_article", "guideline", "textbook", "lecture", "clinical_experience",
    "personal_hypothesis", "ai_summary", "personal_observation", "other", "unknown",
  ]);
  return allowed.has(normalized) ? normalized : "unknown";
}

function normalizeEvidenceStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["verified", "supported", "hypothesis", "unverified"].includes(normalized)
    ? normalized
    : "unverified";
}

function yamlQuote(value) {
  return JSON.stringify(String(value || ""));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { KnowledgeService };
