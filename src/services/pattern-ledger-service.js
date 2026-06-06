const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_SCHEMA_VERSION = 1;

class PatternLedgerService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.filePath = this.config.patternLedgerFile;
  }

  read(args = {}) {
    const ledger = this.loadLedger();
    const filters = normalizeFilters(args);
    const patterns = ledger.patterns
      .filter((pattern) => matchesFilters(pattern, filters))
      .sort(comparePatterns);
    return {
      filePath: this.filePath,
      generatedAt: new Date().toISOString(),
      schemaVersion: ledger.schemaVersion,
      patterns,
      count: patterns.length,
      totalCount: ledger.patterns.length,
    };
  }

  upsert(args = {}) {
    const now = new Date().toISOString();
    const ledger = this.loadLedger();
    const incoming = normalizePatternInput(args, now);
    const existingIndex = findExistingPatternIndex(ledger.patterns, incoming);
    const previous = existingIndex >= 0 ? ledger.patterns[existingIndex] : null;
    const pattern = previous
      ? mergePattern(previous, incoming, now)
      : createPattern(incoming, now);

    if (existingIndex >= 0) {
      ledger.patterns[existingIndex] = pattern;
    } else {
      ledger.patterns.push(pattern);
    }
    ledger.updatedAt = now;
    this.saveLedger(ledger);
    return {
      filePath: this.filePath,
      pattern,
      created: existingIndex < 0,
    };
  }

  addEvidence(args = {}) {
    const patternId = normalizeText(args.patternId);
    if (!patternId) {
      throw new Error("Pattern evidence requires patternId.");
    }
    const now = new Date().toISOString();
    const ledger = this.loadLedger();
    const pattern = ledger.patterns.find((item) => item.id === patternId);
    if (!pattern) {
      throw new Error(`Pattern not found: ${patternId}`);
    }
    pattern.evidence = mergeEvidence(pattern.evidence, normalizeEvidenceList(args.evidence || args));
    pattern.updatedAt = now;
    pattern.lastSeenAt = latestEvidenceDate(pattern.evidence) || pattern.lastSeenAt || "";
    if (Number.isFinite(Number(args.confidence))) {
      pattern.confidence = normalizeConfidence(args.confidence);
    }
    ledger.updatedAt = now;
    this.saveLedger(ledger);
    return { filePath: this.filePath, pattern };
  }

  loadLedger() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return normalizeLedger(parsed);
    } catch {
      return normalizeLedger({});
    }
  }

  saveLedger(ledger) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(normalizeLedger(ledger), null, 2)}\n`, "utf8");
  }
}

function normalizeLedger(value) {
  return {
    schemaVersion: Number.isInteger(value?.schemaVersion) ? value.schemaVersion : DEFAULT_SCHEMA_VERSION,
    updatedAt: normalizeText(value?.updatedAt),
    patterns: Array.isArray(value?.patterns)
      ? value.patterns.map(normalizeStoredPattern).filter(Boolean)
      : [],
  };
}

function normalizeStoredPattern(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const title = normalizeText(value.title);
  if (!title) {
    return null;
  }
  const evidence = normalizeEvidenceList(value.evidence);
  return {
    id: normalizeText(value.id) || stablePatternId({ title, domain: value.domain }),
    title,
    domain: normalizeDomain(value.domain),
    status: normalizeStatus(value.status),
    confidence: normalizeConfidence(value.confidence),
    summary: normalizeText(value.summary),
    hypothesis: normalizeText(value.hypothesis),
    impact: normalizeText(value.impact),
    supportStrategy: normalizeText(value.supportStrategy),
    nextObservation: normalizeText(value.nextObservation),
    tags: normalizeTextArray(value.tags),
    evidence,
    firstSeenAt: normalizeText(value.firstSeenAt) || latestEvidenceDate(evidence) || "",
    lastSeenAt: normalizeText(value.lastSeenAt) || latestEvidenceDate(evidence) || "",
    createdAt: normalizeText(value.createdAt),
    updatedAt: normalizeText(value.updatedAt),
  };
}

function normalizePatternInput(args, now) {
  const title = normalizeText(args.title);
  if (!title) {
    throw new Error("Pattern title is required.");
  }
  const evidence = normalizeEvidenceList(args.evidence);
  return {
    id: normalizeText(args.id),
    title,
    domain: normalizeDomain(args.domain),
    status: normalizeStatus(args.status),
    confidence: normalizeConfidence(args.confidence),
    summary: normalizeText(args.summary),
    hypothesis: normalizeText(args.hypothesis),
    impact: normalizeText(args.impact),
    supportStrategy: normalizeText(args.supportStrategy),
    nextObservation: normalizeText(args.nextObservation),
    tags: normalizeTextArray(args.tags),
    evidence,
    firstSeenAt: normalizeText(args.firstSeenAt) || latestEvidenceDate(evidence) || now,
    lastSeenAt: normalizeText(args.lastSeenAt) || latestEvidenceDate(evidence) || now,
  };
}

function createPattern(input, now) {
  return {
    id: input.id || stablePatternId(input),
    title: input.title,
    domain: input.domain,
    status: input.status,
    confidence: input.confidence,
    summary: input.summary,
    hypothesis: input.hypothesis,
    impact: input.impact,
    supportStrategy: input.supportStrategy,
    nextObservation: input.nextObservation,
    tags: input.tags,
    evidence: input.evidence,
    firstSeenAt: input.firstSeenAt,
    lastSeenAt: input.lastSeenAt,
    createdAt: now,
    updatedAt: now,
  };
}

function mergePattern(previous, incoming, now) {
  const evidence = mergeEvidence(previous.evidence, incoming.evidence);
  return {
    ...previous,
    title: incoming.title || previous.title,
    domain: incoming.domain || previous.domain,
    status: incoming.status || previous.status,
    confidence: incoming.confidence,
    summary: incoming.summary || previous.summary,
    hypothesis: incoming.hypothesis || previous.hypothesis,
    impact: incoming.impact || previous.impact,
    supportStrategy: incoming.supportStrategy || previous.supportStrategy,
    nextObservation: incoming.nextObservation || previous.nextObservation,
    tags: mergeTextArrays(previous.tags, incoming.tags),
    evidence,
    firstSeenAt: earliestTextDate(previous.firstSeenAt, incoming.firstSeenAt) || previous.firstSeenAt || incoming.firstSeenAt,
    lastSeenAt: latestTextDate(previous.lastSeenAt, incoming.lastSeenAt, latestEvidenceDate(evidence)) || previous.lastSeenAt || incoming.lastSeenAt,
    updatedAt: now,
  };
}

function normalizeEvidenceList(value) {
  const list = Array.isArray(value) ? value : value?.date || value?.note || value?.source ? [value] : [];
  return list.map((item) => {
    const date = normalizeText(item?.date);
    const note = normalizeText(item?.note || item?.summary || item?.text);
    const source = normalizeText(item?.source);
    const weight = normalizeEvidenceWeight(item?.weight);
    if (!date && !note) {
      return null;
    }
    return { date, source, note, weight };
  }).filter(Boolean);
}

function mergeEvidence(existing, incoming) {
  const map = new Map();
  for (const item of [...normalizeEvidenceList(existing), ...normalizeEvidenceList(incoming)]) {
    const key = `${item.date}::${item.source}::${item.note}`;
    map.set(key, item);
  }
  return [...map.values()].sort((left, right) => normalizeText(left.date).localeCompare(normalizeText(right.date)));
}

function normalizeFilters(args = {}) {
  return {
    domain: normalizeText(args.domain),
    status: normalizeText(args.status),
    tag: normalizeText(args.tag),
    query: normalizeText(args.query).toLowerCase(),
    minConfidence: Number.isFinite(Number(args.minConfidence)) ? Number(args.minConfidence) : null,
    limit: normalizePositiveInteger(args.limit),
  };
}

function matchesFilters(pattern, filters) {
  if (filters.domain && pattern.domain !== normalizeDomain(filters.domain)) {
    return false;
  }
  if (filters.status && pattern.status !== normalizeStatus(filters.status)) {
    return false;
  }
  if (filters.tag && !pattern.tags.some((tag) => tag.toLowerCase() === filters.tag.toLowerCase())) {
    return false;
  }
  if (filters.minConfidence !== null && pattern.confidence < filters.minConfidence) {
    return false;
  }
  if (filters.query) {
    const haystack = [
      pattern.title,
      pattern.summary,
      pattern.hypothesis,
      pattern.impact,
      pattern.supportStrategy,
      ...pattern.tags,
      ...pattern.evidence.map((item) => item.note),
    ].join("\n").toLowerCase();
    if (!haystack.includes(filters.query)) {
      return false;
    }
  }
  return true;
}

function comparePatterns(left, right) {
  if (right.confidence !== left.confidence) {
    return right.confidence - left.confidence;
  }
  return normalizeText(right.lastSeenAt).localeCompare(normalizeText(left.lastSeenAt));
}

function findExistingPatternIndex(patterns, incoming) {
  if (incoming.id) {
    const byId = patterns.findIndex((pattern) => pattern.id === incoming.id);
    if (byId >= 0) return byId;
  }
  const incomingKey = canonicalPatternKey(incoming);
  return patterns.findIndex((pattern) => canonicalPatternKey(pattern) === incomingKey);
}

function stablePatternId(pattern) {
  const digest = crypto
    .createHash("sha1")
    .update(canonicalPatternKey(pattern))
    .digest("hex")
    .slice(0, 10);
  return `pat_${digest}`;
}

function canonicalPatternKey(pattern) {
  return `${normalizeDomain(pattern.domain)}:${normalizeText(pattern.title).toLowerCase().replace(/\s+/g, " ")}`;
}

function normalizeDomain(value) {
  const normalized = normalizeText(value).toLowerCase();
  const allowed = new Set([
    "energy",
    "sleep",
    "night-shift",
    "work",
    "learning",
    "language",
    "sport",
    "health",
    "emotion",
    "motivation",
    "procrastination",
    "career",
    "research",
    "dance",
    "screen-time",
    "relationship",
    "other",
  ]);
  return allowed.has(normalized) ? normalized : "other";
}

function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["active", "hypothesis", "confirmed", "retired", "contradicted"].includes(normalized)) {
    return normalized;
  }
  return "hypothesis";
}

function normalizeConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0.3;
  }
  return Math.max(0, Math.min(1, Number(numeric.toFixed(2))));
}

function normalizeEvidenceWeight(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.max(0, Math.min(3, Number(numeric.toFixed(2))));
}

function normalizeTextArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(normalizeText).filter(Boolean))]
    : [];
}

function mergeTextArrays(left, right) {
  return [...new Set([...normalizeTextArray(left), ...normalizeTextArray(right)])];
}

function latestEvidenceDate(evidence) {
  return latestTextDate(...normalizeEvidenceList(evidence).map((item) => item.date));
}

function latestTextDate(...dates) {
  return dates.map(normalizeText).filter(Boolean).sort().at(-1) || "";
}

function earliestTextDate(...dates) {
  return dates.map(normalizeText).filter(Boolean).sort()[0] || "";
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { PatternLedgerService };
