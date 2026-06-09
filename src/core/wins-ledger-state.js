class WinsLedgerState {
  constructor() {
    this._pending = new Map();
  }

  setPending(senderId, { task, domain, date }) {
    this._pending.set(String(senderId || "").trim(), { task, domain, date });
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
}

module.exports = { WinsLedgerState };
