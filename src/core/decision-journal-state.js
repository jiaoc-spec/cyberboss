const CONFIRMATION_WORDS = new Set([
  "记录", "好", "好的", "嗯", "对", "要", "yes", "ok", "OK", "确认",
]);

class DecisionJournalState {
  constructor() {
    this._pending = new Map();
  }

  setPending(senderId, { text, date }) {
    this._pending.set(String(senderId || "").trim(), { text, date });
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

function isDecisionJournalConfirmation(text) {
  return CONFIRMATION_WORDS.has(String(text || "").trim());
}

module.exports = { DecisionJournalState, isDecisionJournalConfirmation };
