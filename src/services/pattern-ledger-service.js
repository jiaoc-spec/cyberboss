const crypto = require("crypto");
const fs = require("fs");

const SCHEMA_VERSION = 1;
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);

class PatternLedgerService {
  constructor({ config }) {
    this.config = config;
  }

  async add({
    title = "",
    domain = "",
    observation = "",
    hypothesis = "",
    confidence = "low",
    impact = "",
    tags = [],
    status = "hypothesis",
  } = {}) {
    if (!String(title || "").trim()) {
      throw new Error("pattern_add: title is required.");
    }

    const now = new Date();
    const resolvedConfidence = normalizeConfidence(confidence);
    const pattern = {
      id: `pat_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
      title: String(title).trim(),
      domain: String(domain || "").trim(),
      status: String(status || "hypothesis").trim(),
      confidence: resolvedConfidence,
      observation: String(observation || "").trim(),
      hypothesis: String(hypothesis || "").trim(),
      impact: String(impact || "").trim(),
      tags: Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [],
      evidence: [],
      intervention_ideas: [],
      outcome_tracking: [],
      firstSeenAt: formatDate(now),
      lastSeenAt: formatDate(now),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const ledger = this._load();
    ledger.patterns.push(pattern);
    this._save(ledger);
    return pattern;
  }

  async addEvidence({ id = "", date = "", source = "", note = "", weight = 1 } = {}) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      throw new Error("pattern_add_evidence: id is required.");
    }

    const ledger = this._load();
    const index = ledger.patterns.findIndex((p) => p.id === normalizedId);
    if (index === -1) {
      throw new Error(`pattern_add_evidence: pattern ${normalizedId} not found.`);
    }

    const now = new Date();
    const evidenceDate = String(date || "").trim() || formatDate(now);
    const evidence = {
      date: evidenceDate,
      source: String(source || "").trim(),
      note: String(note || "").trim(),
      weight: Number.isFinite(Number(weight)) ? Number(weight) : 1,
    };

    if (!Array.isArray(ledger.patterns[index].evidence)) {
      ledger.patterns[index].evidence = [];
    }
    ledger.patterns[index].evidence.push(evidence);
    ledger.patterns[index].lastSeenAt = evidenceDate;
    ledger.patterns[index].updatedAt = now.toISOString();
    this._save(ledger);
    return ledger.patterns[index];
  }

  async addIntervention({ id = "", idea = "", target_domain = "" } = {}) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      throw new Error("pattern_add_intervention: id is required.");
    }

    const ledger = this._load();
    const index = ledger.patterns.findIndex((p) => p.id === normalizedId);
    if (index === -1) {
      throw new Error(`pattern_add_intervention: pattern ${normalizedId} not found.`);
    }

    if (!Array.isArray(ledger.patterns[index].intervention_ideas)) {
      ledger.patterns[index].intervention_ideas = [];
    }
    ledger.patterns[index].intervention_ideas.push({
      idea: String(idea || "").trim(),
      target_domain: String(target_domain || "").trim(),
      addedAt: new Date().toISOString(),
      outcome: "",
    });
    ledger.patterns[index].updatedAt = new Date().toISOString();
    this._save(ledger);
    return ledger.patterns[index];
  }

  async trackOutcome({ id = "", intervention_index = 0, outcome = "" } = {}) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      throw new Error("pattern_track_outcome: id is required.");
    }

    const ledger = this._load();
    const patternIndex = ledger.patterns.findIndex((p) => p.id === normalizedId);
    if (patternIndex === -1) {
      throw new Error(`pattern_track_outcome: pattern ${normalizedId} not found.`);
    }

    const ideas = ledger.patterns[patternIndex].intervention_ideas;
    if (!Array.isArray(ideas) || !ideas[intervention_index]) {
      throw new Error(`pattern_track_outcome: intervention_index ${intervention_index} not found.`);
    }

    ideas[intervention_index].outcome = String(outcome || "").trim();
    ideas[intervention_index].trackedAt = new Date().toISOString();
    ledger.patterns[patternIndex].updatedAt = new Date().toISOString();
    this._save(ledger);
    return ledger.patterns[patternIndex];
  }

  async list({ domain = "", status = "", limit = 0 } = {}) {
    const ledger = this._load();
    let patterns = ledger.patterns.slice().reverse();

    if (String(domain || "").trim()) {
      const d = String(domain).trim().toLowerCase();
      patterns = patterns.filter((p) => String(p.domain || "").toLowerCase().includes(d));
    }
    if (String(status || "").trim()) {
      const s = String(status).trim().toLowerCase();
      patterns = patterns.filter((p) => String(p.status || "").toLowerCase() === s);
    }

    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 0;
    if (safeLimit) {
      patterns = patterns.slice(0, safeLimit);
    }

    return { patterns, total: patterns.length };
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.config.patternLedgerFile, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.patterns)) {
        return { schemaVersion: SCHEMA_VERSION, patterns: [] };
      }
      return parsed;
    } catch {
      return { schemaVersion: SCHEMA_VERSION, patterns: [] };
    }
  }

  _save(ledger) {
    const data = { schemaVersion: SCHEMA_VERSION, ...ledger, updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.config.patternLedgerFile, JSON.stringify(data, null, 2), "utf8");
  }
}

function normalizeConfidence(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (VALID_CONFIDENCE.has(normalized)) {
    return normalized;
  }
  const num = Number(value);
  if (Number.isFinite(num)) {
    if (num >= 0.7) return "high";
    if (num >= 0.4) return "medium";
    return "low";
  }
  return "low";
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

module.exports = { PatternLedgerService };
