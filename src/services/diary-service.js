const fs = require("fs");
const path = require("path");

const { resolveBodyInput } = require("./text-input");

class DiaryService {
  constructor({ config }) {
    this.config = config;
  }

  async append({ text = "", textFile = "", title = "", date = "", time = "" } = {}) {
    const body = await resolveBodyInput({ text, textFile });
    if (!body) {
      throw new Error("Diary content cannot be empty. Pass text or textFile.");
    }

    const now = new Date();
    const timeZone = this.config.diaryTimeZone || "UTC";
    const dateString = date || formatDate(now, timeZone);
    const timeString = time || formatTime(now, timeZone);
    if (this.config.diaryBackend === "obsidian") {
      return this.appendObsidian({
        dateString,
        timeString,
        title,
        body,
      });
    }

    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
    const entry = buildDiaryEntry({
      timeString,
      title,
      body,
    });

    fs.mkdirSync(this.config.diaryDir, { recursive: true });
    const prefix = fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? "\n\n" : "";
    fs.appendFileSync(filePath, `${prefix}${entry}`, "utf8");
    return {
      filePath,
      date: dateString,
      time: timeString,
      body,
    };
  }

  appendObsidian({ dateString, timeString, title, body }) {
    const vaultDir = normalizeText(this.config.obsidianVaultDir);
    if (!vaultDir) {
      throw new Error("CYBERBOSS_DIARY_BACKEND=obsidian requires OBSIDIAN_VAULT_DIR or CYBERBOSS_OBSIDIAN_VAULT_DIR.");
    }
    const dailyFolder = normalizeText(this.config.obsidianDailyFolder) || "03. 🔵 Tagebuch/01. 日记";
    const section = normalizeText(this.config.obsidianDailySection) || "## 今日记录";
    const filePath = path.join(vaultDir, dailyFolder, `${dateString}.md`);
    const templatePath = resolveObsidianTemplatePath(this.config, vaultDir);
    const existing = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf8")
      : buildObsidianDailyNote({ dateString, templatePath });
    const entry = buildDiaryEntry({
      timeString,
      title,
      body,
      headingPrefix: "###",
    });
    const updated = appendToMarkdownSection(existing, section, entry);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${updated.trimEnd()}\n`, "utf8");
    return {
      filePath,
      backend: "obsidian",
      date: dateString,
      time: timeString,
      body,
    };
  }
}

function buildDiaryEntry({ timeString, title, body, headingPrefix = "##" }) {
  const prefix = normalizeHeadingPrefix(headingPrefix);
  const heading = title ? `${prefix} ${timeString} ${String(title).trim()}` : `${prefix} ${timeString}`;
  return `${heading}\n\n${body}`;
}

function buildObsidianDailyNote({ dateString, templatePath }) {
  if (templatePath && fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, "utf8").replaceAll("{{date}}", dateString);
  }
  return `---\ntype: daily\ndate: ${dateString}\nsource: cyberboss\ninput_mode: conversation\nmanual_input_required: false\n---\n\n# ${dateString} 日记\n\n## 今日记录\n`;
}

function appendToMarkdownSection(markdown, section, content) {
  const normalizedSection = normalizeText(section);
  const normalizedContent = normalizeText(content);
  if (!normalizedContent) {
    return markdown;
  }
  let text = String(markdown || "").trimEnd();
  if (!normalizedSection) {
    return `${text}\n\n${normalizedContent}`;
  }
  const lines = text.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => normalizeText(line) === normalizedSection);
  if (sectionIndex < 0) {
    return `${text}\n\n${normalizedSection}\n\n${normalizedContent}`;
  }
  const sectionLevel = headingLevel(normalizedSection);
  let insertIndex = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const level = headingLevel(lines[index]);
    if (level > 0 && level <= sectionLevel) {
      insertIndex = index;
      break;
    }
  }
  const before = lines.slice(0, insertIndex).join("\n").trimEnd();
  const after = lines.slice(insertIndex).join("\n").trimStart();
  return after
    ? `${before}\n\n${normalizedContent}\n\n${after}`
    : `${before}\n\n${normalizedContent}`;
}

function headingLevel(line) {
  const match = normalizeText(line).match(/^(#{1,6})\s+\S/);
  return match ? match[1].length : 0;
}

function resolveObsidianTemplatePath(config, vaultDir) {
  const explicit = normalizeText(config.obsidianDailyTemplateFile);
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(vaultDir, explicit);
  }
  return path.join(vaultDir, "资料库", "模版", "日记.md");
}

function formatDate(date, timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTime(date, timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHeadingPrefix(value) {
  const normalized = normalizeText(value);
  return /^#{1,6}$/.test(normalized) ? normalized : "##";
}

module.exports = {
  DiaryService,
  appendToMarkdownSection,
  buildDiaryEntry,
  buildObsidianDailyNote,
  formatDate,
  formatTime,
};
