const crypto = require("crypto");
const fs = require("fs");

const SCHEMA_VERSION = 1;

class WinsService {
  constructor({ config }) {
    this.config = config;
  }

  async record({
    task = "",
    domain = "",
    success_factor = "",
    evidence = "",
    energy_context = "",
    shift_context = "",
    reminder_context = "",
    note = "",
    date = "",
  } = {}) {
    if (!String(task || "").trim()) {
      throw new Error("wins_record: task is required.");
    }
    if (!String(success_factor || "").trim()) {
      throw new Error("wins_record: success_factor is required.");
    }

    const now = new Date();
    const win = {
      id: `win_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
      date: date || formatDate(now),
      task: String(task).trim(),
      domain: String(domain || "").trim(),
      success_factor: String(success_factor).trim(),
      evidence: String(evidence || "").trim(),
      energy_context: String(energy_context || "").trim(),
      shift_context: String(shift_context || "").trim(),
      reminder_context: String(reminder_context || "").trim(),
      note: String(note || "").trim(),
      createdAt: now.toISOString(),
    };

    const ledger = this._load();
    ledger.wins.push(win);
    this._save(ledger);
    return win;
  }

  async query({ task = "", domain = "", since = "", limit = 0 } = {}) {
    const ledger = this._load();
    let wins = ledger.wins.slice();

    if (String(task || "").trim()) {
      const t = String(task).trim().toLowerCase();
      wins = wins.filter((w) => String(w.task || "").toLowerCase().includes(t));
    }
    if (String(domain || "").trim()) {
      const d = String(domain).trim().toLowerCase();
      wins = wins.filter((w) => String(w.domain || "").toLowerCase().includes(d));
    }
    if (String(since || "").trim()) {
      wins = wins.filter((w) => String(w.date || "") >= String(since).trim());
    }

    wins = wins.slice().reverse();
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 0;
    if (safeLimit) {
      wins = wins.slice(0, safeLimit);
    }

    return { wins, total: wins.length };
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.config.winsLedgerFile, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.wins)) {
        return { schemaVersion: SCHEMA_VERSION, wins: [] };
      }
      return parsed;
    } catch {
      return { schemaVersion: SCHEMA_VERSION, wins: [] };
    }
  }

  _save(ledger) {
    const data = { schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), ...ledger };
    fs.writeFileSync(this.config.winsLedgerFile, JSON.stringify(data, null, 2), "utf8");
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

module.exports = { WinsService };
