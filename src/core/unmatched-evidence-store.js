const crypto = require("crypto");
const fs = require("fs");

class UnmatchedEvidenceStore {
  constructor({ filePath }) {
    this.filePath = filePath;
  }

  append({ originDomain, note, source, date }) {
    const store = this._load();
    store.unmatchedEvidence.push({
      id: `ue_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
      originDomain: String(originDomain || "").trim(),
      note: String(note || "").trim(),
      source: String(source || "").trim(),
      date: String(date || "").trim(),
      createdAt: new Date().toISOString(),
    });
    store.updatedAt = new Date().toISOString();
    this._save(store);
  }

  list() {
    return this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.unmatchedEvidence)) {
        return { schemaVersion: 1, unmatchedEvidence: [], updatedAt: new Date().toISOString() };
      }
      return parsed;
    } catch {
      return { schemaVersion: 1, unmatchedEvidence: [], updatedAt: new Date().toISOString() };
    }
  }

  _save(store) {
    fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2), "utf8");
  }
}

module.exports = { UnmatchedEvidenceStore };
