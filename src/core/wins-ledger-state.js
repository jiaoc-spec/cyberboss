class WinsLedgerState {
  constructor() {
    this._pending = new Map();
    this._lastRecorded = new Map();
  }

  setPending(senderId, { task, domain, date, promptedAt = "" }) {
    this._pending.set(String(senderId || "").trim(), { task, domain, date, promptedAt });
  }

  getPending(senderId) {
    return this._pending.get(String(senderId || "").trim()) || null;
  }

  clearPending(senderId) {
    this._pending.delete(String(senderId || "").trim());
  }

  hasPending(senderId) {
    return this._pending.has(String(senderId || "").trim());
  }

  setLastRecorded(senderId, entry = {}) {
    this._lastRecorded.set(String(senderId || "").trim(), { ...entry });
  }

  getLastRecorded(senderId) {
    return this._lastRecorded.get(String(senderId || "").trim()) || null;
  }

  clearLastRecorded(senderId) {
    this._lastRecorded.delete(String(senderId || "").trim());
  }

  markAsked(senderId, task, date) {
    if (!this._asked) this._asked = new Set();
    this._asked.add(`${String(senderId || "").trim()}:${String(task || "").trim()}:${String(date || "").trim()}`);
  }

  wasAsked(senderId, task, date) {
    if (!this._asked) return false;
    return this._asked.has(`${String(senderId || "").trim()}:${String(task || "").trim()}:${String(date || "").trim()}`);
  }
}

module.exports = { WinsLedgerState };
