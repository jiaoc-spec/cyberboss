const crypto = require("crypto");
const fs = require("fs");

const { createChannelAdapter } = require("../adapters/channel");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
const { readCurrentStateFile, evaluateBusyState } = require("../services/current-state-service");
const { evaluatePlanPhase, readPlanForDate, shouldDeferForOperationsPlan } = require("../services/day-operations-planner-service");
const { getActiveFocusSession } = require("../services/focus-protection-service");

const INTERNAL_CHECKIN_TRIGGER_TEMPLATE = [
  "Random companionship check-in for %USER%.",
  "This is not a task reminder and not a guardian trigger.",
  "Use daily state/calendar/current-state context if needed before deciding whether to speak.",
  "If there is no clear useful or emotionally fitting reason to interrupt, return silent.",
].join("\n");
const SLEEP_CHECKIN_PROTECTION_HOURS = 10;

async function runSystemCheckinPoller(config) {
  const channelAdapter = createChannelAdapter(config);
  const account = channelAdapter.resolveAccount();
  const contextTokens = typeof channelAdapter.getKnownContextTokens === "function"
    ? channelAdapter.getKnownContextTokens()
    : {};
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });
  const target = resolvePollerTarget({ config, account, sessionStore, contextTokens });
  const defaultRange = resolveDefaultCheckinRange();
  let currentRange = checkinConfigStore.getRange(defaultRange);

  console.log(`[cyberboss] checkin poller ready user=${target.senderId} workspace=${target.workspaceRoot}`);
  console.log(`[cyberboss] checkin interval range ${formatRangeMinutes(currentRange)}`);

  while (true) {
    currentRange = checkinConfigStore.getRange(defaultRange);
    const delayMs = pickRandomDelayMs(currentRange.minIntervalMs, currentRange.maxIntervalMs);
    const wakeAt = formatLocalTime(Date.now() + delayMs, config.timeZone || config.diaryTimeZone);
    console.log(`[cyberboss] next checkin in ${Math.round(delayMs / 60000)}m at ${wakeAt}`);
    await sleep(delayMs);

    if (queue.hasPendingForAccount(account.accountId)) {
      console.log("[cyberboss] checkin skipped: pending system message still in queue");
      continue;
    }
    const protectedState = getProtectedCheckinState({ config, target, now: new Date() });
    if (protectedState.skip) {
      console.log(`[cyberboss] checkin skipped: ${protectedState.reason}`);
      continue;
    }

    const queued = queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildCheckinTrigger(config),
      createdAt: new Date().toISOString(),
    });
    console.log(`[cyberboss] checkin queued id=${queued.id}`);
  }
}

function resolvePollerTarget({ config, account, sessionStore, contextTokens }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
    sessionStore,
    contextTokens,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the channel user for the checkin poller. Set CYBERBOSS_CHECKIN_USER_ID or let the only active user talk to the bot once first.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for the checkin poller. Set CYBERBOSS_WORKSPACE_ROOT first.");
  }

  return { senderId, workspaceRoot };
}

function pickRandomDelayMs(minIntervalMs, maxIntervalMs) {
  if (maxIntervalMs <= minIntervalMs) {
    return minIntervalMs;
  }
  return minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalTime(value, timeZone = "UTC") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: normalizeText(timeZone) || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function localDateText(value, timeZone = "UTC") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeText(timeZone) || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatRangeMinutes(range) {
  return `${Math.round(range.minIntervalMs / 60000)}m-${Math.round(range.maxIntervalMs / 60000)}m`;
}

function buildCheckinTrigger(config) {
  const userName = normalizeText(config?.userName) || "the user";
  return INTERNAL_CHECKIN_TRIGGER_TEMPLATE.replace("%USER%", userName);
}

function getProtectedCheckinState({ config = {}, target = {}, now = new Date() } = {}) {
  const focusState = readJsonState(config.focusProtectionStateFile, { sessions: [] });
  const focus = getActiveFocusSession(focusState, {
    senderKey: `telegram:${normalizeText(target.senderId)}`,
    now,
  }) || getActiveFocusSession(focusState, {
    senderKey: `weixin:${normalizeText(target.senderId)}`,
    now,
  });
  if (focus) {
    return {
      skip: true,
      reason: `focus protection active task=${focus.task}`,
    };
  }
  if (config.currentStateFile) {
    const busy = evaluateBusyState(readCurrentStateFile(config.currentStateFile), now);
    if (busy.busy) {
      return {
        skip: true,
        reason: `explicit busy state active state=${busy.state} age=${busy.ageMinutes}m`,
      };
    }
  }
  const operations = getProtectedOperationsPlanState({ config, now });
  if (operations.skip) {
    return operations;
  }
  const state = readTimelineAutoCaptureState(config.timelineAutoCaptureStateFile);
  const pending = state.pending || {};
  const senderId = normalizeText(target.senderId);
  if (!senderId) {
    return { skip: false };
  }
  const candidates = Object.entries(pending)
    .filter(([key]) => key.endsWith(`:${senderId}`))
    .map(([, value]) => value)
    .filter(Boolean);
  for (const candidate of candidates) {
    const classification = candidate.classification || {};
    const subcategoryId = normalizeText(classification.subcategoryId);
    const title = normalizeText(classification.title);
    const text = normalizeText(candidate.text);
    if (!isSleepLikePending({ subcategoryId, title, text })) {
      continue;
    }
    const start = Date.parse(normalizeText(candidate.startAt));
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
    if (!Number.isFinite(start) || !Number.isFinite(nowMs)) {
      continue;
    }
    const ageHours = (nowMs - start) / 3_600_000;
    if (ageHours >= 0 && ageHours <= SLEEP_CHECKIN_PROTECTION_HOURS) {
      return {
        skip: true,
        reason: `protected sleep/rest window active age=${ageHours.toFixed(1)}h`,
      };
    }
  }
  return { skip: false };
}

function getProtectedOperationsPlanState({ config = {}, now = new Date() } = {}) {
  const filePath = normalizeText(config.dayOperationsPlanStateFile);
  if (!filePath) {
    return { skip: false };
  }
  const timeZone = normalizeText(config.timeZone || config.diaryTimeZone) || "UTC";
  const date = localDateText(now, timeZone);
  const plan = readPlanForDate(filePath, date);
  if (!plan) {
    return { skip: false };
  }
  const currentPhase = evaluatePlanPhase({ plan, now });
  const evaluatedPlan = { ...plan, currentPhase };
  if (!shouldDeferForOperationsPlan(evaluatedPlan)) {
    return { skip: false };
  }
  return {
    skip: true,
    reason: `day operations protected phase=${currentPhase.kind} reason=${currentPhase.reason}`,
  };
}

function readJsonState(filePath, fallback) {
  const normalized = normalizeText(filePath);
  if (!normalized || !fs.existsSync(normalized)) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(normalized, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readTimelineAutoCaptureState(filePath) {
  const normalized = normalizeText(filePath);
  if (!normalized || !fs.existsSync(normalized)) {
    return { pending: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(normalized, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { pending: {} };
  } catch {
    return { pending: {} };
  }
}

function isSleepLikePending({ subcategoryId = "", title = "", text = "" } = {}) {
  const combined = `${subcategoryId}\n${title}\n${text}`;
  return /(rest\.nap|sleep|睡|补觉|午睡|休息|躺床|躺下|nap)/i.test(combined);
}

module.exports = { runSystemCheckinPoller, getProtectedCheckinState, getProtectedOperationsPlanState };
