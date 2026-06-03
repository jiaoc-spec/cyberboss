const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

class HealthService {
  constructor({ config, diary }) {
    this.config = config || {};
    this.diary = diary;
  }

  async importPending({ limit = 20 } = {}) {
    const inboxDir = normalizeText(this.config.healthInboxDir);
    if (!inboxDir || !this.diary) {
      return { imported: [], skipped: [], inboxDir };
    }
    await fsp.mkdir(inboxDir, { recursive: true });
    const state = await readJsonFile(this.config.healthImportStateFile, { imported: {} });
    const files = await listImportableFiles(inboxDir);
    const imported = [];
    const skipped = [];
    for (const filePath of files) {
      if (imported.length >= limit) {
        break;
      }
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) {
        continue;
      }
      const fingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`;
      const stateKey = path.resolve(filePath);
      if (state.imported?.[stateKey]?.fingerprint === fingerprint) {
        skipped.push({ filePath, reason: "already_imported" });
        continue;
      }
      if (Date.now() - stat.mtimeMs < 2_000) {
        skipped.push({ filePath, reason: "file_still_changing" });
        continue;
      }

      const entry = await buildHealthDiaryEntry(filePath, {
        defaultSource: this.config.healthSourceLabel,
        timeZone: this.config.diaryTimeZone || this.config.timeZone,
      });
      const result = await this.diary.append({
        title: "Health 自动记录",
        text: entry.body,
        date: entry.date,
        time: entry.time,
      });
      state.imported[stateKey] = {
        fingerprint,
        importedAt: new Date().toISOString(),
        diaryFilePath: result.filePath,
      };
      imported.push({
        filePath,
        diaryFilePath: result.filePath,
        date: entry.date,
        time: entry.time,
      });
    }
    await writeJsonFile(this.config.healthImportStateFile, state);
    return { imported, skipped, inboxDir };
  }
}

async function buildHealthDiaryEntry(filePath, options = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = await fsp.readFile(filePath, "utf8");
  const source = normalizeText(options.defaultSource) || "Apple Health / Shortcuts";
  if (ext === ".json") {
    const parsed = JSON.parse(raw);
    return buildJsonHealthEntry(parsed, { filePath, source, timeZone: options.timeZone });
  }
  return buildPlainHealthEntry(raw, { filePath, source, timeZone: options.timeZone });
}

function buildJsonHealthEntry(payload, { filePath, source, timeZone }) {
  const rows = Array.isArray(payload) ? payload : [payload];
  const first = rows.find((item) => item && typeof item === "object" && !Array.isArray(item)) || {};
  const date = normalizeDate(first.date || first.day || first.startDate || first.start || first.createdAt, timeZone);
  const time = normalizeTime(first.time || first.createdAt || first.endDate || first.end || first.startDate || first.start, timeZone);
  const lines = [
    `- 来源：${normalizeText(first.source) || source}`,
    `- 导入文件：${path.basename(filePath)}`,
  ];
  const recordedAt = normalizeText(first.recordedAt || first.createdAt || first.timestamp);
  if (recordedAt) {
    lines.push(`- 数据时间：${recordedAt}`);
  }

  if (rows.length === 1) {
    lines.push("", "#### 指标");
    lines.push(...formatHealthObject(first));
  } else {
    lines.push("", "#### 指标");
    rows.forEach((item, index) => {
      lines.push(`- 记录 ${index + 1}`);
      formatHealthObject(item).forEach((line) => lines.push(`  ${line}`));
    });
  }
  return {
    date,
    time,
    body: lines.join("\n").trim(),
  };
}

function buildPlainHealthEntry(raw, { filePath, source, timeZone }) {
  const now = new Date();
  return {
    date: formatDate(now, timeZone),
    time: formatTime(now, timeZone),
    body: [
      `- 来源：${source}`,
      `- 导入文件：${path.basename(filePath)}`,
      "",
      "```text",
      raw.trim(),
      "```",
    ].join("\n"),
  };
}

function formatHealthObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`- 原始值：${String(value)}`];
  }
  const preferred = [
    ["sleep", "睡眠"],
    ["sleepHours", "睡眠时长"],
    ["sleepMinutes", "睡眠时长"],
    ["steps", "步数"],
    ["distanceKm", "步行/跑步距离"],
    ["activeEnergyKcal", "活动能量"],
    ["workouts", "运动"],
    ["exerciseMinutes", "运动分钟"],
    ["restingHeartRate", "静息心率"],
    ["heartRate", "心率"],
    ["weight", "体重"],
    ["mindfulMinutes", "正念分钟"],
    ["mood", "心情"],
    ["energy", "能量"],
    ["symptoms", "症状"],
  ];
  const seen = new Set();
  const lines = [];
  for (const [key, label] of preferred) {
    if (value[key] === undefined || value[key] === null || value[key] === "") {
      continue;
    }
    seen.add(key);
    lines.push(`- ${label}：${formatMetricValue(value[key])}`);
  }
  const extraEntries = Object.entries(value)
    .filter(([key, item]) => !seen.has(key) && !["date", "day", "time", "source", "createdAt", "timestamp", "recordedAt"].includes(key) && item !== undefined && item !== null && item !== "");
  for (const [key, item] of extraEntries) {
    lines.push(`- ${key}：${formatMetricValue(item)}`);
  }
  return lines.length ? lines : ["- 未记录具体指标"];
}

function formatMetricValue(value) {
  if (Array.isArray(value)) {
    if (!value.length) {
      return "未记录";
    }
    return value.map((item) => formatMetricValue(item)).join("；");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}=${formatMetricValue(item)}`)
      .join(", ");
  }
  return String(value);
}

async function listImportableFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    if (/\.(json|txt|md|csv)$/i.test(entry.name)) {
      files.push(filePath);
    }
  }
  files.sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs);
  return files;
}

function normalizeDate(value, timeZone = "UTC") {
  const normalized = normalizeText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }
  const parsed = Date.parse(normalized);
  return formatDate(Number.isFinite(parsed) ? new Date(parsed) : new Date(), timeZone);
}

function normalizeTime(value, timeZone = "UTC") {
  const normalized = normalizeText(value);
  if (/^\d{2}:\d{2}$/.test(normalized)) {
    return normalized;
  }
  const parsed = Date.parse(normalized);
  return formatTime(Number.isFinite(parsed) ? new Date(parsed) : new Date(), timeZone);
}

function formatDate(date, timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeText(timeZone) || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTime(date, timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: normalizeText(timeZone) || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, filePath);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  HealthService,
  buildHealthDiaryEntry,
  formatHealthObject,
};
