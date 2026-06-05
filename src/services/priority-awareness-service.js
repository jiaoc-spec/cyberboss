const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { DEFAULT_LEVEL_A, DEFAULT_LEVEL_B, DEFAULT_LEVEL_C, matchesHabit } = require("./critical-habits-monitor");

const ACTIVE_STATUSES = new Set(["pending", "unknown"]);
const CLOSED_STATUSES = new Set(["completed", "postponed", "skipped", "cancelled"]);
const VALID_STATUSES = new Set([...ACTIVE_STATUSES, ...CLOSED_STATUSES]);

class PriorityAwarenessService {
  constructor({ config, timeline = null, channelAdapter = null, sessionStore = null, systemMessageQueue = null }) {
    this.config = config || {};
    this.timeline = timeline;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.systemMessageQueue = systemMessageQueue;
    this.stateFile = this.config.priorityAwarenessStateFile;
    this.lastCheckAtMs = 0;
  }

  set({
    date = "",
    priorities = [],
    deadlineAt = "",
    deadlineLabel = "",
    sourceText = "",
  } = {}) {
    const targetDate = normalizeDate(date) || localDate(new Date(), this.timeZone());
    const parsedDeadline = normalizeFutureDateTime(deadlineAt);
    if (!parsedDeadline) {
      throw new Error("Priority awareness requires a valid timezone-aware deadlineAt.");
    }
    if (!Array.isArray(priorities) || !priorities.length) {
      throw new Error("Priority awareness requires at least one priority.");
    }

    const state = this.loadState();
    const previous = state.days[targetDate] || {};
    const previousById = new Map((previous.priorities || []).map((item) => [item.id, item]));
    const normalizedPriorities = priorities.map((item) => normalizePriority(item)).filter(Boolean);
    if (!normalizedPriorities.length) {
      throw new Error("Priority awareness priorities must have a label.");
    }

    const now = new Date().toISOString();
    const day = {
      date: targetDate,
      deadlineAt: parsedDeadline,
      deadlineLabel: normalizeText(deadlineLabel) || "截止时间",
      sourceText: normalizeText(sourceText),
      priorities: normalizedPriorities.map((item) => {
        const old = previousById.get(item.id);
        return {
          ...item,
          status: VALID_STATUSES.has(old?.status) ? old.status : "pending",
          completedAt: old?.completedAt || "",
          updatedAt: now,
        };
      }),
      awareness: {
        lastPromptAt: previous.awareness?.lastPromptAt || "",
        promptedCheckpoints: previous.awareness?.promptedCheckpoints || {},
        needsReevaluationAt: previous.awareness?.needsReevaluationAt || "",
      },
      createdAt: previous.createdAt || now,
      updatedAt: now,
    };
    state.days[targetDate] = day;
    this.saveState(state);
    return day;
  }

  status({ date = "" } = {}) {
    const targetDate = normalizeDate(date) || localDate(new Date(), this.timeZone());
    const state = this.loadState();
    return state.days[targetDate] || {
      date: targetDate,
      deadlineAt: "",
      deadlineLabel: "",
      priorities: [],
      awareness: {},
    };
  }

  update({ date = "", priorityId = "", label = "", status = "", note = "" } = {}) {
    const targetDate = normalizeDate(date) || localDate(new Date(), this.timeZone());
    const normalizedStatus = normalizeText(status).toLowerCase();
    if (!VALID_STATUSES.has(normalizedStatus)) {
      throw new Error(`Invalid priority status: ${status}`);
    }
    const state = this.loadState();
    const day = state.days[targetDate];
    if (!day) {
      throw new Error(`No priority awareness state for ${targetDate}.`);
    }
    const target = findPriority(day.priorities, { priorityId, label });
    if (!target) {
      throw new Error(`Priority not found: ${priorityId || label}`);
    }
    const now = new Date().toISOString();
    target.status = normalizedStatus;
    target.note = normalizeText(note);
    target.completedAt = normalizedStatus === "completed" ? now : "";
    target.updatedAt = now;
    day.updatedAt = now;
    day.awareness = day.awareness || {};
    day.awareness.needsReevaluationAt = now;
    this.saveState(state);
    return day;
  }

  observeMessage({ text = "", receivedAt = "" } = {}) {
    const body = normalizeText(text);
    if (!body || !looksLikeCompletion(body)) {
      return { updated: [], day: null };
    }
    const receivedDate = parseDateOrNow(receivedAt);
    const targetDate = localDate(receivedDate, this.timeZone());
    return this.markMatchingCompleted({
      date: targetDate,
      matcher: (priority) => matchesPriorityText(body, priority),
      completedAt: receivedDate.toISOString(),
      note: body,
    });
  }

  observeEvents({ date = "", events = [] } = {}) {
    if (!Array.isArray(events) || !events.length) {
      return { updated: [], day: null };
    }
    const targetDate = normalizeDate(date)
      || localDate(parseDateOrNow(events[0]?.startAt), this.timeZone());
    return this.markMatchingCompleted({
      date: targetDate,
      matcher: (priority) => events.some((event) => matchesHabit(event, priorityToHabit(priority))),
      completedAt: new Date().toISOString(),
      note: "Timeline completion evidence",
    });
  }

  async check(account, now = new Date()) {
    if (!this.config.priorityAwarenessEnabled || !this.systemMessageQueue) {
      return { queued: [] };
    }
    const intervalMs = this.config.priorityAwarenessCheckIntervalMs || 300_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { queued: [] };
    }
    this.lastCheckAtMs = now.getTime();

    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot) {
      return { queued: [] };
    }

    const targetDate = localDate(now, this.timeZone());
    const state = this.loadState();
    const day = state.days[targetDate];
    if (!day?.deadlineAt || !Array.isArray(day.priorities) || !day.priorities.length) {
      return { queued: [] };
    }

    await this.syncTimelineEvidence(day);
    const deadlineMs = Date.parse(day.deadlineAt);
    const remainingMs = deadlineMs - now.getTime();
    const pending = day.priorities.filter((item) => ACTIVE_STATUSES.has(item.status));
    if (!Number.isFinite(deadlineMs) || remainingMs <= 0 || !pending.length) {
      this.saveState(state);
      return { queued: [] };
    }

    const awareness = day.awareness || (day.awareness = {});
    const cooldownMs = this.config.priorityAwarenessCooldownMs || 60 * 60_000;
    const lastPromptMs = Date.parse(awareness.lastPromptAt || "");
    if (Number.isFinite(lastPromptMs) && now.getTime() - lastPromptMs < cooldownMs) {
      this.saveState(state);
      return { queued: [] };
    }

    const feasibility = buildFeasibilityState({
      day,
      pending,
      now,
      bufferMinutes: this.config.priorityAwarenessBoundaryBufferMinutes,
      checkIntervalMs: this.config.priorityAwarenessCheckIntervalMs,
      timeZone: this.timeZone(),
    });
    const checkpoint = dueFeasibilityCheckpoint(day, now, feasibility)
      || dueCheckpoint(day, now, this.config.priorityAwarenessCheckpointMinutes);
    const reevaluationMs = Date.parse(awareness.needsReevaluationAt || "");
    const hasFreshReevaluation = Number.isFinite(reevaluationMs)
      && (!Number.isFinite(lastPromptMs) || reevaluationMs > lastPromptMs);
    if (!checkpoint && !hasFreshReevaluation) {
      this.saveState(state);
      return { queued: [] };
    }

    const message = this.enqueueAwarenessMessage({ account, target, day, pending, remainingMs, feasibility, now });
    awareness.lastPromptAt = now.toISOString();
    awareness.needsReevaluationAt = "";
    awareness.promptedCheckpoints = awareness.promptedCheckpoints || {};
    if (checkpoint) {
      awareness.promptedCheckpoints[checkpoint] = now.toISOString();
    }
    day.updatedAt = now.toISOString();
    this.saveState(state);
    return { queued: [message] };
  }

  queueWakeReentry(account, { receivedAt = "" } = {}) {
    if (!this.config.priorityAwarenessEnabled || !this.systemMessageQueue) {
      return { queued: [] };
    }
    const now = parseDateOrNow(receivedAt);
    const target = this.resolveTarget(account);
    if (!target.senderId || !target.workspaceRoot) {
      return { queued: [] };
    }

    const targetDate = localDate(now, this.timeZone());
    const state = this.loadState();
    const day = state.days[targetDate] || {
      date: targetDate,
      deadlineAt: "",
      deadlineLabel: "",
      priorities: [],
      awareness: {},
      createdAt: now.toISOString(),
    };
    const awareness = day.awareness || (day.awareness = {});
    const lastWakeMs = Date.parse(awareness.lastWakeReentryAt || "");
    const cooldownMs = this.config.priorityAwarenessWakeCooldownMs || 2 * 60 * 60_000;
    if (Number.isFinite(lastWakeMs) && now.getTime() - lastWakeMs < cooldownMs) {
      state.days[targetDate] = day;
      this.saveState(state);
      return { queued: [] };
    }

    const active = (day.priorities || []).filter((item) => ACTIVE_STATUSES.has(item.status));
    const completed = (day.priorities || []).filter((item) => item.status === "completed");
    const explicit = Boolean((day.priorities || []).length);
    const text = [
      "Wake-up reentry Priority Awareness trigger.",
      `${this.config.userName || "Jane"} just reported that she is awake. The previous sleep/rest protection window should now be considered ended.`,
      explicit
        ? `Today's explicit priority boundary: ${day.deadlineLabel || "unknown"} ${day.deadlineAt || ""}`.trim()
        : "There is no explicit priority boundary recorded today. Use Level A as the default long-term-priority set: Sport, Deutsch, Englisch.",
      explicit ? `Completed: ${completed.length ? completed.map((item) => item.label).join(", ") : "none recorded"}.` : "",
      explicit ? `Still open: ${active.length ? active.map((item) => item.label).join(", ") : "none"}.` : "",
      "Send one short, natural, affectionate-but-not-novelistic message only if useful. Reconnect her to the most important priorities after waking, without pressure. If she sounds exhausted, offer one minimum version or a gentle first step. Do not ask what she is doing; she just told you she woke up.",
    ].filter(Boolean).join("\n");

    const message = this.systemMessageQueue.enqueue({
      id: `priority-wake-reentry:${targetDate}:${crypto.randomUUID()}`,
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text,
      createdAt: now.toISOString(),
    });
    awareness.lastWakeReentryAt = now.toISOString();
    day.updatedAt = now.toISOString();
    state.days[targetDate] = day;
    this.saveState(state);
    console.log(`[cyberboss] priority wake reentry queued date=${targetDate}`);
    return { queued: [message] };
  }

  async syncTimelineEvidence(day) {
    if (!this.timeline || !day?.date) {
      return;
    }
    try {
      const result = await this.timeline.read({ date: day.date });
      const events = Array.isArray(result?.data?.events) ? result.data.events : [];
      if (events.length) {
        this.observeEvents({ date: day.date, events });
        const refreshed = this.status({ date: day.date });
        day.priorities = refreshed.priorities;
        day.awareness = refreshed.awareness;
      }
    } catch (error) {
      console.error(`[cyberboss] priority awareness timeline read failed date=${day.date}: ${error.message}`);
    }
  }

  markMatchingCompleted({ date, matcher, completedAt, note }) {
    const state = this.loadState();
    const day = state.days[date];
    if (!day) {
      return { updated: [], day: null };
    }
    const updated = [];
    for (const priority of day.priorities || []) {
      if (ACTIVE_STATUSES.has(priority.status) && matcher(priority)) {
        priority.status = "completed";
        priority.completedAt = completedAt;
        priority.note = note;
        priority.updatedAt = completedAt;
        updated.push(priority.id);
      }
    }
    if (updated.length) {
      day.awareness = day.awareness || {};
      day.awareness.needsReevaluationAt = completedAt;
      day.updatedAt = completedAt;
      this.saveState(state);
    }
    return { updated, day };
  }

  enqueueAwarenessMessage({ account, target, day, pending, remainingMs, feasibility, now }) {
    const completed = day.priorities.filter((item) => item.status === "completed");
    const closed = day.priorities.filter((item) => CLOSED_STATUSES.has(item.status) && item.status !== "completed");
    const text = [
      "Priority Awareness Assistant trigger.",
      `Today ${this.config.userName} explicitly chose these priorities before ${day.deadlineLabel}: ${day.priorities.map((item) => item.label).join(", ")}.`,
      `Completed: ${completed.length ? completed.map((item) => item.label).join(", ") : "none recorded"}.`,
      `Still open: ${pending.map((item) => item.label).join(", ")}.`,
      closed.length ? `Consciously closed or postponed: ${closed.map((item) => `${item.label} (${item.status})`).join(", ")}.` : "",
      `Time remaining until the boundary: ${formatRemaining(remainingMs)}.`,
      `Estimated full-version time for open priorities: ${formatRemaining(feasibility.activityMinutes * 60_000)} (${pending.map((item) => `${item.label} ${estimatePriorityMinutes(item)}m`).join(", ")}).`,
      `Reserved boundary preparation buffer: ${feasibility.bufferMinutes} minutes.`,
      `Latest practical start time for the full versions: ${feasibility.latestStartLabel}.`,
      feasibility.isFeasible
        ? "There is still enough estimated time for the full versions if she chooses to begin now."
        : feasibility.isAtEdge
          ? "The latest practical start window is at its edge now. Restore awareness immediately without claiming that there is plenty of time."
        : "There is no longer enough estimated time for all full versions before the boundary. Do not imply that full completion is still realistic; offer a conscious choice between a minimum version, postponing, skipping, or revising the plan.",
      "Send one short, gentle but steadfast priority-awareness message only if it is useful now. Reconnect her with what she already chose, summarize completed and open items, and offer a choice about which one to advance. Be reality-aware: distinguish whether this is a smallest-return moment or a real-rest moment. Emotional support is welcome, but do not comfort her in a way that makes the chosen priorities disappear. Do not command, supervise, shame, or invent an execution order. A list is unordered unless she explicitly specified an order. Always Return matters more than perfect streaks.",
    ].filter(Boolean).join("\n");
    const message = this.systemMessageQueue.enqueue({
      id: `priority-awareness:${day.date}:${crypto.randomUUID()}`,
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text,
      createdAt: now.toISOString(),
    });
    console.log(`[cyberboss] priority awareness queued date=${day.date} pending=${pending.map((item) => item.id).join(",")}`);
    return message;
  }

  resolveTarget(account) {
    const contextTokens = typeof this.channelAdapter?.getKnownContextTokens === "function"
      ? this.channelAdapter.getKnownContextTokens()
      : {};
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      sessionStore: this.sessionStore,
      contextTokens,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: account.accountId,
      senderId,
      sessionStore: this.sessionStore,
    });
    return { senderId, workspaceRoot };
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return { days: parsed?.days && typeof parsed.days === "object" ? parsed.days : {} };
    } catch {
      return { days: {} };
    }
  }

  saveState(state) {
    if (!this.stateFile) {
      return;
    }
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(pruneState(state), null, 2)}\n`, "utf8");
  }
}

function normalizePriority(value) {
  const input = typeof value === "string" ? { label: value } : value || {};
  const label = normalizeText(input.label || input.name);
  if (!label) {
    return null;
  }
  const known = findKnownHabit(label);
  return {
    id: normalizeId(input.id) || known?.id || normalizeId(label),
    label,
    level: normalizeLevel(input.level) || known?.level || "A",
    keywords: normalizeStringArray(input.keywords).length
      ? normalizeStringArray(input.keywords)
      : known?.keywords || [label],
    categoryPrefixes: normalizeStringArray(input.categoryPrefixes).length
      ? normalizeStringArray(input.categoryPrefixes)
      : known?.categoryPrefixes || [],
    meaning: normalizeText(input.meaning) || known?.meaning || "",
    estimatedMinutes: normalizePositiveInteger(input.estimatedMinutes) || known?.estimatedMinutes || 30,
  };
}

function findKnownHabit(label) {
  const normalized = label.toLowerCase();
  for (const [level, habits] of [["A", DEFAULT_LEVEL_A], ["B", DEFAULT_LEVEL_B], ["C", DEFAULT_LEVEL_C]]) {
    const found = habits.find((item) => item.id === normalizeId(label)
      || item.label.toLowerCase() === normalized
      || item.keywords.some((keyword) => normalized.includes(keyword.toLowerCase())));
    if (found) {
      return { ...found, level };
    }
  }
  return null;
}

function matchesPriorityText(text, priority) {
  const normalized = text.toLowerCase();
  return [priority.label, ...(priority.keywords || [])]
    .filter(Boolean)
    .some((keyword) => normalized.includes(String(keyword).toLowerCase()));
}

function priorityToHabit(priority) {
  return {
    keywords: [priority.label, ...(priority.keywords || [])].filter(Boolean),
    categoryPrefixes: priority.categoryPrefixes || [],
  };
}

function findPriority(priorities, { priorityId, label }) {
  const id = normalizeId(priorityId);
  const normalizedLabel = normalizeText(label).toLowerCase();
  return (priorities || []).find((item) => (id && item.id === id)
    || (normalizedLabel && item.label.toLowerCase() === normalizedLabel));
}

function dueCheckpoint(day, now, configuredMinutes) {
  const deadlineMs = Date.parse(day.deadlineAt);
  const prompted = day.awareness?.promptedCheckpoints || {};
  const minutes = Array.isArray(configuredMinutes) && configuredMinutes.length
    ? configuredMinutes
    : [120, 45];
  for (const minute of [...minutes].sort((a, b) => b - a)) {
    const key = String(minute);
    if (!prompted[key] && now.getTime() >= deadlineMs - minute * 60_000) {
      return key;
    }
  }
  return "";
}

function buildFeasibilityState({ day, pending, now, bufferMinutes, checkIntervalMs, timeZone }) {
  const deadlineMs = Date.parse(day.deadlineAt);
  const activityMinutes = pending.reduce((total, item) => total + estimatePriorityMinutes(item), 0);
  const normalizedBufferMinutes = Number.isInteger(bufferMinutes) && bufferMinutes >= 0 ? bufferMinutes : 30;
  const requiredMinutes = activityMinutes + normalizedBufferMinutes;
  const latestStartMs = deadlineMs - requiredMinutes * 60_000;
  const graceMs = Math.max(60_000, Number(checkIntervalMs) || 300_000);
  return {
    activityMinutes,
    bufferMinutes: normalizedBufferMinutes,
    requiredMinutes,
    latestStartMs,
    latestStartLabel: formatLocalTime(latestStartMs, timeZone),
    isFeasible: now.getTime() <= latestStartMs,
    isAtEdge: now.getTime() > latestStartMs && now.getTime() <= latestStartMs + graceMs,
  };
}

function estimatePriorityMinutes(priority) {
  return normalizePositiveInteger(priority?.estimatedMinutes)
    || findKnownHabit(normalizeText(priority?.label))?.estimatedMinutes
    || 30;
}

function dueFeasibilityCheckpoint(day, now, feasibility) {
  if (!Number.isFinite(feasibility?.latestStartMs) || now.getTime() < feasibility.latestStartMs) {
    return "";
  }
  const pendingIds = (day.priorities || [])
    .filter((item) => ACTIVE_STATUSES.has(item.status))
    .map((item) => item.id)
    .sort()
    .join(",");
  const key = `feasibility:${pendingIds}:${feasibility.requiredMinutes}`;
  return day.awareness?.promptedCheckpoints?.[key] ? "" : key;
}

function formatRemaining(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) {
    return `${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hours ${rest} minutes` : `${hours} hours`;
}

function looksLikeCompletion(text) {
  return /(完成|做完|学完|练完|结束|已经.*(做|学|练|完成)|done|finished|completed)/i.test(text);
}

function normalizeFutureDateTime(value) {
  const text = normalizeText(value);
  if (!text || !/([zZ]|[+-]\d{2}:\d{2})$/.test(text)) {
    return "";
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeDate(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function localDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function parseDateOrNow(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeId(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeLevel(value) {
  const level = normalizeText(value).toUpperCase();
  return ["A", "B", "C"].includes(level) ? level : "";
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map(normalizeText).filter(Boolean) : [];
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function formatLocalTime(timestamp, timeZone) {
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

function pruneState(state) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 45);
  return {
    days: Object.fromEntries(Object.entries(state.days || {}).filter(([date]) => {
      const parsed = Date.parse(`${date}T12:00:00Z`);
      return Number.isFinite(parsed) && parsed >= cutoff.getTime();
    })),
  };
}

module.exports = {
  PriorityAwarenessService,
  ACTIVE_STATUSES,
  VALID_STATUSES,
  looksLikeCompletion,
  normalizePriority,
};
