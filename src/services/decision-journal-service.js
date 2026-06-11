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
    const entryDate = date || formatDate(now, this._timeZone());
    const defaultReviewDays = Number(this.config?.decisionReviewDefaultDays) || 14;
    const entry = {
      id: `dec_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
      date: entryDate,
      decision: String(decision).trim(),
      context: String(context || "").trim(),
      reasons: String(reasons || "").trim(),
      expected_outcome: String(expected_outcome || "").trim(),
      risks: String(risks || "").trim(),
      review_date: String(review_date || "").trim() || addDaysText(entryDate, defaultReviewDays),
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

  async listDueForReview({ date = "" } = {}) {
    const today = String(date || "").trim() || formatDate(new Date(), this._timeZone());
    const journal = this._load();
    return journal.decisions.filter((entry) =>
      String(entry.review_date || "").trim()
      && entry.review_date <= today
      && !String(entry.later_outcome || "").trim()
      && !String(entry.reviewRequestedAt || "").trim());
  }

  async markReviewRequested({ id = "", at = new Date() } = {}) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      throw new Error("decision_review: id is required.");
    }
    const journal = this._load();
    const index = journal.decisions.findIndex((d) => d.id === normalizedId);
    if (index === -1) {
      throw new Error(`decision_review: decision ${normalizedId} not found.`);
    }
    journal.decisions[index] = {
      ...journal.decisions[index],
      reviewRequestedAt: at instanceof Date ? at.toISOString() : String(at),
      updatedAt: new Date().toISOString(),
    };
    this._save(journal);
    return journal.decisions[index];
  }

  _timeZone() {
    return this.config?.timeZone || this.config?.diaryTimeZone || "Asia/Shanghai";
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

function formatDate(date, timeZone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDaysText(dateText, days) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

module.exports = { DecisionJournalService };
