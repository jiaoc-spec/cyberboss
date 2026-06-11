const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;
const ITEM_TYPES = ["paper", "idea", "writing", "contact", "course", "other"];

// Academic asset ledger: the compounding record of papers read, ideas captured,
// writing produced, and people met on the way to research work.
class ResearchLedgerService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.filePath = this.config.researchLedgerFile;
  }

  async record({ type = "", title = "", note = "", link = "", tags = [], date = "" } = {}) {
    const normalizedType = String(type || "").trim().toLowerCase();
    if (!ITEM_TYPES.includes(normalizedType)) {
      throw new Error(`research_record: type must be one of ${ITEM_TYPES.join(", ")}.`);
    }
    if (!String(title || "").trim()) {
      throw new Error("research_record: title is required.");
    }
    const now = new Date();
    const entry = {
      id: `res_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
      type: normalizedType,
      title: String(title).trim(),
      note: String(note || "").trim(),
      link: String(link || "").trim(),
      tags: Array.isArray(tags) ? [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))] : [],
      date: String(date || "").trim() || formatDate(now, this.timeZone()),
      createdAt: now.toISOString(),
    };
    const ledger = this._load();
    ledger.items.push(entry);
    this._save(ledger);
    return entry;
  }

  async query({ type = "", query = "", from = "", to = "", limit = 0 } = {}) {
    const ledger = this._load();
    const normalizedType = String(type || "").trim().toLowerCase();
    const normalizedQuery = String(query || "").trim().toLowerCase();
    let items = ledger.items.slice().reverse();
    if (normalizedType) {
      items = items.filter((item) => item.type === normalizedType);
    }
    if (from) {
      items = items.filter((item) => item.date >= from);
    }
    if (to) {
      items = items.filter((item) => item.date <= to);
    }
    if (normalizedQuery) {
      items = items.filter((item) =>
        [item.title, item.note, item.link, ...(item.tags || [])].join("\n").toLowerCase().includes(normalizedQuery));
    }
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 0;
    if (safeLimit) {
      items = items.slice(0, safeLimit);
    }
    const counts = {};
    for (const item of ledger.items) {
      counts[item.type] = (counts[item.type] || 0) + 1;
    }
    return { items, total: items.length, countsByType: counts };
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || !Array.isArray(parsed.items)) {
        return { schemaVersion: SCHEMA_VERSION, items: [] };
      }
      return parsed;
    } catch {
      return { schemaVersion: SCHEMA_VERSION, items: [] };
    }
  }

  _save(ledger) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const data = { schemaVersion: SCHEMA_VERSION, ...ledger, updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

module.exports = { ResearchLedgerService, ITEM_TYPES };
