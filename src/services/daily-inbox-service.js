const fs = require("fs");
const path = require("path");

class DailyInboxService {
  constructor({ config }) {
    this.config = config || {};
  }

  append({ text = "", date = "", time = "", provider = "", senderId = "" } = {}) {
    const body = normalizeText(text);
    if (!body) {
      throw new Error("Daily inbox content cannot be empty.");
    }
    const timeZone = this.config.diaryTimeZone || this.config.timeZone || "UTC";
    const now = new Date();
    const dateString = normalizeText(date) || formatDate(now, timeZone);
    const timeString = normalizeText(time) || formatTime(now, timeZone);
    const filePath = path.join(this.config.dailyInboxDir, `${dateString}.md`);
    const lines = [
      `### ${timeString}`,
      "",
      `- 来源：${normalizeText(provider) || "channel"}`,
    ];
    if (normalizeText(senderId)) {
      lines.push(`- sender：${normalizeText(senderId)}`);
    }
    lines.push("- 原始输入：");
    lines.push(...quoteMarkdown(body));
    appendFile(filePath, lines.join("\n"));
    return { filePath, date: dateString, time: timeString };
  }

  read({ date = "" } = {}) {
    const dateString = normalizeText(date) || formatDate(new Date(), this.config.diaryTimeZone || this.config.timeZone || "UTC");
    const filePath = path.join(this.config.dailyInboxDir, `${dateString}.md`);
    return {
      filePath,
      date: dateString,
      exists: fs.existsSync(filePath),
      text: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "",
    };
  }

  archive({ date = "" } = {}) {
    const dateString = normalizeText(date);
    if (!dateString) {
      throw new Error("Daily inbox archive requires a date in YYYY-MM-DD.");
    }
    const sourcePath = path.join(this.config.dailyInboxDir, `${dateString}.md`);
    const archivePath = path.join(this.config.dailyInboxArchiveDir, `${dateString}.md`);
    if (!fs.existsSync(sourcePath)) {
      return { date: dateString, archived: false, sourcePath, archivePath };
    }
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    if (fs.existsSync(archivePath)) {
      const existing = fs.readFileSync(archivePath, "utf8").trimEnd();
      const incoming = fs.readFileSync(sourcePath, "utf8").trim();
      fs.writeFileSync(archivePath, `${existing}\n\n${incoming}\n`, "utf8");
      fs.unlinkSync(sourcePath);
    } else {
      fs.renameSync(sourcePath, archivePath);
    }
    return { date: dateString, archived: true, sourcePath, archivePath };
  }
}

function appendFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const prefix = fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? "\n\n" : "";
  fs.appendFileSync(filePath, `${prefix}${content.trim()}\n`, "utf8");
}

function quoteMarkdown(text) {
  return String(text || "").split(/\r?\n/).map((line) => `> ${line}`);
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTime(date, timeZone) {
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

module.exports = { DailyInboxService };
