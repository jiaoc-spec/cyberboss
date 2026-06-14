const fs = require("fs");

const { isDecisionJournalConfirmation } = require("../core/decision-journal-state");
const { parseWinsResponse } = require("../core/wins-trigger");
const { parseDigestionReply } = require("./digestion-service");
const { parseAnswer } = require("./missing-context-service");

const PENDING_PRIORITIES = {
  playbook_quick_start: 95,
  shift_rating: 90,
  missing_context: 85,
  wins_ledger: 80,
  decision_journal: 70,
  digestion: 60,
};

class ContextEngineService {
  constructor({ config = {}, services = {} } = {}) {
    this.config = config;
    this.services = services;
  }

  async analyzeIncoming({
    normalized = {},
    now = null,
    decisionJournalState = null,
    winsLedgerState = null,
    playbook = null,
  } = {}) {
    const at = parseDateOrNow(now || normalized.receivedAt);
    const text = normalizeText(normalized.text);
    const answerText = extractAnswerText(text);
    const senderId = normalizeText(normalized.senderId);
    const provider = normalizeText(normalized.provider) || "channel";
    const senderKey = provider && senderId ? `${provider}:${senderId}` : senderId;
    const pendingReplies = collectPendingReplies({
      config: this.config,
      services: this.services,
      normalized,
      now: at,
      text,
      answerText,
      senderId,
      senderKey,
      decisionJournalState,
      winsLedgerState,
      playbook: playbook || this.services.playbook,
    });
    const current = readCurrentSituation({
      services: this.services,
      normalized,
      now: at,
      senderId,
      provider,
    });
    const pendingReply = selectPendingReply(pendingReplies);
    const guardLines = buildGuardLines({ current, pendingReply, normalized, answerText });
    const protections = buildProtections(current);
    return {
      kind: "context_engine_v2",
      now: at.toISOString(),
      senderId,
      senderKey,
      text,
      answerText,
      replyToText: normalizeText(normalized.replyToText || normalized.replyTo?.text),
      pendingReplies,
      pendingReply,
      current,
      protections,
      guardLines,
      riskyForCheapRouting: Boolean(pendingReply || protections.length || normalizeText(normalized.replyToText || normalized.replyTo?.text)),
    };
  }
}

class AssistantCommandCenter {
  constructor({ config = {} } = {}) {
    this.config = config;
  }

  decideIncoming(context = {}) {
    const pendingReplyTarget = normalizeText(context?.pendingReply?.target);
    const riskReasons = [];
    if (pendingReplyTarget) {
      riskReasons.push(`pending_reply:${pendingReplyTarget}`);
    }
    for (const protection of context?.protections || []) {
      riskReasons.push(`protection:${protection}`);
    }
    if (context?.replyToText) {
      riskReasons.push("reply_context");
    }
    return {
      pendingReplyTarget,
      pendingReply: context?.pendingReply || null,
      requiresCodex: riskReasons.length > 0,
      riskReasons,
      guardLines: Array.isArray(context?.guardLines) ? context.guardLines : [],
    };
  }

  buildRuntimeGuardLines(context = {}) {
    return Array.isArray(context?.guardLines) ? context.guardLines : [];
  }
}

function collectPendingReplies({
  config,
  services,
  normalized,
  now,
  text,
  answerText,
  senderId,
  senderKey,
  decisionJournalState,
  winsLedgerState,
  playbook,
}) {
  const pending = [];
  const shift = readShiftRatingPending(config.shiftRatingStateFile, senderKey);
  if (shift) {
    pending.push({
      target: "shift_rating",
      label: "Shift fatigue score",
      promptedAt: shift.promptedAt,
      priority: PENDING_PRIORITIES.shift_rating,
      likelyAnswer: looksLikeFatigueScoreAnswer(answerText),
      reason: "open shift-rating prompt",
    });
  }

  const missing = readMissingContextPending(config.missingContextStateFile, localDateText(now, timeZone(config)), senderKey);
  if (missing) {
    pending.push({
      target: "missing_context",
      label: missing.title || missing.field || "Missing context question",
      promptedAt: missing.promptedAt,
      priority: PENDING_PRIORITIES.missing_context,
      likelyAnswer: Boolean(parseAnswer(answerText, missing)),
      reason: "open missing-context question",
    });
  }

  const winsPending = winsLedgerState?.getPending?.(senderId);
  if (winsPending) {
    pending.push({
      target: "wins_ledger",
      label: "Wins Ledger success-factor answer",
      promptedAt: winsPending.promptedAt || "",
      priority: PENDING_PRIORITIES.wins_ledger,
      likelyAnswer: Boolean(parseWinsResponse(answerText)),
      reason: "open wins-ledger question",
    });
  }

  const decisionPending = decisionJournalState?.getPending?.(senderId);
  if (decisionPending) {
    pending.push({
      target: "decision_journal",
      label: "Decision Journal confirmation",
      promptedAt: decisionPending.promptedAt || "",
      priority: PENDING_PRIORITIES.decision_journal,
      likelyAnswer: isDecisionJournalConfirmation(answerText),
      reason: "open decision-journal confirmation",
    });
  }

  const quickStart = playbook?.pendingQuickStart?.({ now });
  if (quickStart) {
    pending.push({
      target: "playbook_quick_start",
      label: quickStart.label || quickStart.task || "Playbook quick start",
      promptedAt: quickStart.sentAt || "",
      priority: PENDING_PRIORITIES.playbook_quick_start,
      likelyAnswer: /^(1|好|好的|开始|开始吧|ok|go)$/i.test(answerText),
      reason: "open playbook quick-start prompt",
    });
  }

  const digestion = readDigestionPending(config.digestionStateFile, now);
  if (digestion) {
    pending.push({
      target: "digestion",
      label: "Weekly digestion selection",
      promptedAt: digestion.offeredAt || "",
      priority: PENDING_PRIORITIES.digestion,
      likelyAnswer: Boolean(parseDigestionReply(answerText, digestion.candidateCount)),
      reason: "open digestion offer",
    });
  }

  return pending
    .filter((item) => item && item.target)
    .map((item) => ({ ...item, answerPreview: normalizeText(text).slice(0, 80) }));
}

function selectPendingReply(pendingReplies = []) {
  const matches = pendingReplies.filter((item) => item.likelyAnswer);
  if (!matches.length) {
    return null;
  }
  return matches
    .slice()
    .sort((left, right) => {
      const byTime = toMs(right.promptedAt) - toMs(left.promptedAt);
      if (byTime) return byTime;
      return (Number(right.priority) || 0) - (Number(left.priority) || 0);
    })[0];
}

function readCurrentSituation({ services = {}, normalized = {}, now = new Date(), senderId = "", provider = "" } = {}) {
  const current = safeCall(() => services.currentState?.current?.({ now })) || null;
  const busy = safeCall(() => services.currentState?.isBusyNow?.({ now })) || { busy: false };
  const focus = safeCall(() => services.focusProtection?.isProtected?.({
    senderId: senderId || normalized.senderId,
    provider: provider || normalized.provider,
    now,
  })) || { protected: false };
  return { current, busy, focus };
}

function buildProtections(current = {}) {
  const protections = [];
  const state = normalizeText(current?.current?.state);
  if (current?.focus?.protected) {
    protections.push("focus_active");
  }
  if (current?.busy?.busy) {
    protections.push(`busy_${current.busy.state || state || "unknown"}`);
  }
  if (state === "going_to_sleep") {
    protections.push("sleep_window");
  }
  return protections;
}

function buildGuardLines({ current = {}, pendingReply = null, normalized = {}, answerText = "" } = {}) {
  const lines = [];
  if (pendingReply) {
    lines.push(`Command Center: the current message is likely answering a pending ${pendingReply.target} question (${pendingReply.label}). Do not reinterpret "${answerText}" as a new diary fact or a different score.`);
  }
  const replyToText = normalizeText(normalized.replyToText || normalized.replyTo?.text);
  if (replyToText) {
    lines.push(`Reply context: the user replied to "${replyToText.slice(0, 180)}". Use this only to resolve what the current message refers to; do not answer the quoted text as if it is new.`);
  }
  const state = normalizeText(current?.current?.state);
  if (["commuting_to_work", "at_work"].includes(state) || current?.busy?.busy) {
    lines.push("Command Center: she is currently commuting to work or on shift. Do not suggest sleeping, napping, showering, packing, tidying, cooking, starting a long workout/study block, or any home-only action right now. Support the actual work/commute context and plan recovery after work.");
  }
  if (state === "going_to_sleep") {
    lines.push("Command Center: she said she is going to sleep/rest. Do not ask non-urgent questions, do not send Level A nudges, and do not restart planning until she speaks again or a true hard-boundary reminder is due.");
  }
  if (current?.focus?.protected) {
    lines.push(`Command Center: Focus Mode is active for ${current.focus.session?.task || "Focus"}. Avoid unrelated reminders and ask only about this focus task when it ends.`);
  }
  return lines;
}

function readShiftRatingPending(filePath, senderKey) {
  const parsed = readJson(filePath);
  const prompt = parsed?.lastPromptBySender?.[senderKey];
  return prompt?.promptedAt && !prompt?.answeredAt ? prompt : null;
}

function readMissingContextPending(filePath, date, senderKey) {
  const parsed = readJson(filePath);
  const questions = parsed?.days?.[date]?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  return questions
    .filter((item) => item.senderKey === senderKey && item.status === "prompted")
    .sort((left, right) => toMs(right.promptedAt) - toMs(left.promptedAt))[0] || null;
}

function readDigestionPending(filePath, now = new Date()) {
  const parsed = readJson(filePath);
  const pending = parsed?.pendingOffer;
  if (!pending?.offeredAt || !Array.isArray(pending.candidates)) {
    return null;
  }
  const ageMs = now.getTime() - Date.parse(pending.offeredAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 7 * 24 * 60 * 60_000) {
    return null;
  }
  return { ...pending, candidateCount: pending.candidates.length };
}

function looksLikeFatigueScoreAnswer(text) {
  const body = normalizeText(text);
  return /^(?:10|[0-9](?:\.[0-9])?)(?:\s*分)?\s*(?:吧|左右|多|了)?$/i.test(body)
    || /(?:^|[^\d])(?:10|[0-9](?:\.[0-9])?)\s*\/\s*10(?:\D|$)/.test(body)
    || /(?:疲惫|疲劳|累|能量|状态|打分|分数).{0,12}(?:10|[0-9](?:\.[0-9])?)/.test(body);
}

function extractAnswerText(text) {
  const body = normalizeText(text);
  const quotedMatch = body.match(/^\[Quoted:[\s\S]*?\]\s*\n+([\s\S]+)$/i);
  return normalizeText(quotedMatch ? quotedMatch[1] : body);
}

function readJson(filePath) {
  const normalized = normalizeText(filePath);
  if (!normalized || !fs.existsSync(normalized)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(normalized, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function parseDateOrNow(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function localDateText(date, zone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function timeZone(config = {}) {
  return config.diaryTimeZone || config.timeZone || "UTC";
}

function toMs(value) {
  const ms = Date.parse(normalizeText(value));
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

module.exports = {
  AssistantCommandCenter,
  ContextEngineService,
  extractAnswerText,
  selectPendingReply,
};
