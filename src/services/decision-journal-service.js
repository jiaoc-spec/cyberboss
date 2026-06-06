const crypto = require("crypto");
const fs = require("fs");

const SCHEMA_VERSION = 1;

class DecisionJournalService {
  constructor({ config }) {
    this.config = config;
  }

  async record({
    decision = "",
    context = "",
    reasons = "",
    expected_outcome = "",
    risks = "",
    review_date = "",
    date = "",
  } = {}) {
    if (!String(decision || "").trim()) {
      throw new Error("decision_record: decision text is required.");
    }

    const now = new Date();
    const entry = {
      id: `dec_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
      date: date || formatDate(now),
      decision: String(decision).trim(),
      context: String(context || "").trim(),
      reasons: String(reasons || "").trim(),
      expected_outcome: String(expected_outcome || "").trim(),
      risks: String(risks || "").trim(),
      review_date: String(review_date || "").trim(),
      later_outcome: "",
      reflection: "",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const journal = this._load();
    journal.decisions.push(entry);
    this._save(journal);
    return entry;
  }

  async updateOutcome({ id = "", later_outcome = "", reflection = "" } = {}) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      throw new Error("decision_update: id is required.");
    }

    const journal = this._load();
    const index = journal.decisions.findIndex((d) => d.id === normalizedId);
    if (index === -1) {
      throw new Error(`decision_update: decision ${normalizedId} not found.`);
    }

    journal.decisions[index] = {
      ...journal.decisions[index],
      later_outcome: String(later_outcome || "").trim(),
      reflection: String(reflection || "").trim(),
      updatedAt: new Date().toISOString(),
    };
    this._save(journal);
    return journal.decisions[index];
  }

  async list({ pending_review_only = false, limit = 0 } = {}) {
    const journal = this._load();
    let decisions = journal.decisions.slice().reverse();

    if (pending_review_only) {
      decisions = decisions.filter((d) => !String(d.later_outcome || "").trim());
    }

    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 0;
    if (safeLimit) {
      decisions = decisions.slice(0, safeLimit);
    }

    return { decisions, total: decisions.length };
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.config.decisionJournalFile, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.decisions)) {
        return { schemaVersion: SCHEMA_VERSION, decisions: [] };
      }
      return parsed;
    } catch {
      return { schemaVersion: SCHEMA_VERSION, decisions: [] };
    }
  }

  _save(journal) {
    const data = { schemaVersion: SCHEMA_VERSION, ...journal, updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.config.decisionJournalFile, JSON.stringify(data, null, 2), "utf8");
  }
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

module.exports = { DecisionJournalService };
