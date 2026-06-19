const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  evaluatePlanPhase,
  readPlanForDate,
  shouldDeferForOperationsPlan,
} = require("./day-operations-planner-service");
const { evaluateBusyState, readCurrentStateFile } = require("./current-state-service");
const { getActiveFocusSession } = require("./focus-protection-service");

const DEFAULT_CATEGORY_LIMITS = {
  guardian: 2,
  reflection: 1,
  knowledge: 1,
  companionship: 1,
};

// One shared gate for every unsolicited user-facing intervention. Individual
// monitors still decide what is useful; this coordinator decides whether the
// whole assistant has already spoken enough today and whether the moment is
// protected by work, class, focus, sleep, or recovery.
class ProactiveInterventionCoordinator {
  constructor({ config = {} } = {}) {
    this.config = config;
    this.stateFile = config.proactiveInterventionStateFile;
  }

  request({
    source = "unknown",
    category = "guardian",
    priority = "normal",
    subject = "",
    accountId = "",
    senderId = "",
    provider = "telegram",
    now = new Date(),
    operationsPlan = null,
    bypassProtections = false,
  } = {}) {
    const at = parseDate(now);
    if (this.config.proactiveInterventionEnabled === false) {
      return { allowed: true, reason: "disabled", reservationId: "" };
    }

    const normalized = {
      source: normalizeText(source) || "unknown",
      category: normalizeCategory(category),
      priority: normalizePriority(priority),
      subject: normalizeText(subject),
      accountId: normalizeText(accountId),
      senderId: normalizeText(senderId),
      provider: normalizeText(provider) || "telegram",
    };
    if (normalized.priority === "required") {
      return { allowed: true, reason: "required", reservationId: "" };
    }

    if (!bypassProtections) {
      const protectedState = this.readProtectedState({
        now: at,
        senderId: normalized.senderId,
        provider: normalized.provider,
        operationsPlan,
      });
      if (protectedState.blocked && normalized.priority !== "hard_boundary") {
        return { allowed: false, reason: protectedState.reason, reservationId: "" };
      }
      if (protectedState.kind === "do_not_disturb") {
        return { allowed: false, reason: protectedState.reason, reservationId: "" };
      }
    }

    const date = localDate(at, this.timeZone());
    const state = this.loadState();
    const day = ensureDay(state, date);
    const events = day.events.filter((event) => isWithinRetention(event, at, 36));
    day.events = events;

    const duplicateWindowMs = this.duplicateWindowMinutes(normalized.priority) * 60_000;
    const duplicate = events.find((event) => (
      event.source === normalized.source
      && event.subject === normalized.subject
      && at.getTime() - Date.parse(event.createdAt) < duplicateWindowMs
    ));
    if (duplicate) {
      this.saveState(state);
      return { allowed: false, reason: "duplicate_intervention", reservationId: "" };
    }

    const last = events.at(-1);
    const minGapMs = this.minimumGapMinutes(normalized.priority) * 60_000;
    if (last && at.getTime() - Date.parse(last.createdAt) < minGapMs) {
      this.saveState(state);
      return { allowed: false, reason: "minimum_gap", reservationId: "" };
    }

    const dailyMax = this.dailyMax();
    const totalLimit = normalized.priority === "hard_boundary" ? dailyMax + 1 : dailyMax;
    if (events.length >= totalLimit) {
      this.saveState(state);
      return { allowed: false, reason: "daily_budget", reservationId: "" };
    }

    const categoryCount = events.filter((event) => event.category === normalized.category).length;
    const categoryLimit = this.categoryLimit(normalized.category);
    if (categoryCount >= categoryLimit && normalized.priority !== "hard_boundary") {
      this.saveState(state);
      return { allowed: false, reason: `category_budget_${normalized.category}`, reservationId: "" };
    }

    const reservation = {
      id: `pi_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      ...normalized,
      createdAt: at.toISOString(),
      status: "reserved",
    };
    day.events.push(reservation);
    day.updatedAt = at.toISOString();
    state.days[date] = day;
    state.days = pruneDays(state.days, date, 21);
    this.saveState(state);
    return {
      allowed: true,
      reason: normalized.priority === "hard_boundary" ? "hard_boundary" : "within_budget",
      reservationId: reservation.id,
      counts: {
        total: day.events.length,
        category: categoryCount + 1,
      },
    };
  }

  release(reservationId = "") {
    const id = normalizeText(reservationId);
    if (!id) return false;
    const state = this.loadState();
    let removed = false;
    for (const day of Object.values(state.days)) {
      const before = day.events.length;
      day.events = day.events.filter((event) => event.id !== id);
      removed = removed || day.events.length !== before;
    }
    if (removed) this.saveState(state);
    return removed;
  }

  snapshot({ date = "", now = new Date() } = {}) {
    const targetDate = normalizeText(date) || localDate(parseDate(now), this.timeZone());
    const state = this.loadState();
    const events = Array.isArray(state.days[targetDate]?.events) ? state.days[targetDate].events : [];
    return {
      date: targetDate,
      dailyMax: this.dailyMax(),
      used: events.length,
      remaining: Math.max(0, this.dailyMax() - events.length),
      events,
    };
  }

  readProtectedState({ now, senderId, provider, operationsPlan }) {
    const focus = readFocusState(this.config.focusProtectionStateFile, {
      senderId,
      provider,
      now,
    });
    if (focus) {
      return { blocked: true, kind: "focus", reason: "focus_active" };
    }

    if (this.config.currentStateFile) {
      const busy = evaluateBusyState(readCurrentStateFile(this.config.currentStateFile), now);
      if (busy.busy || busy.state === "going_to_sleep") {
        return { blocked: true, kind: busy.state || "busy", reason: `current_state_${busy.state || "busy"}` };
      }
    }

    const plan = operationsPlan || this.readPersistedOperationsPlan(now);
    if (plan) {
      const currentPhase = plan.currentPhase || evaluatePlanPhase({ plan, now });
      const evaluated = { ...plan, currentPhase };
      if (shouldDeferForOperationsPlan(evaluated)) {
        return {
          blocked: true,
          kind: currentPhase.kind,
          reason: `day_operations_${currentPhase.kind}`,
        };
      }
    }
    return { blocked: false, kind: "available", reason: "available" };
  }

  readPersistedOperationsPlan(now) {
    const filePath = normalizeText(this.config.dayOperationsPlanStateFile);
    if (!filePath) return null;
    return readPlanForDate(filePath, localDate(now, this.timeZone()));
  }

  dailyMax() {
    const value = Number(this.config.proactiveInterventionDailyMax);
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 3;
  }

  minimumGapMinutes(priority) {
    if (priority === "hard_boundary") {
      const value = Number(this.config.proactiveInterventionHardBoundaryGapMinutes);
      return Number.isFinite(value) && value >= 0 ? value : 20;
    }
    const value = Number(this.config.proactiveInterventionMinGapMinutes);
    return Number.isFinite(value) && value >= 0 ? value : 90;
  }

  duplicateWindowMinutes(priority) {
    return priority === "hard_boundary" ? 30 : 180;
  }

  categoryLimit(category) {
    const configured = this.config.proactiveInterventionCategoryLimits;
    const value = Number(configured?.[category]);
    return Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : (DEFAULT_CATEGORY_LIMITS[category] || 1);
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }

  loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      return {
        schemaVersion: 1,
        days: parsed?.days && typeof parsed.days === "object" ? parsed.days : {},
      };
    } catch {
      return { schemaVersion: 1, days: {} };
    }
  }

  saveState(state) {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function readFocusState(filePath, { senderId, provider, now }) {
  const normalized = normalizeText(filePath);
  if (!normalized || !senderId) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(normalized, "utf8"));
    const senderKey = `${normalizeText(provider) || "telegram"}:${senderId}`;
    return getActiveFocusSession(parsed, { senderKey, now });
  } catch {
    return null;
  }
}

function ensureDay(state, date) {
  const current = state.days[date];
  if (current && Array.isArray(current.events)) return current;
  return { date, events: [], updatedAt: "" };
}

function pruneDays(days, currentDate, retentionDays) {
  const cutoff = addDays(currentDate, -retentionDays);
  return Object.fromEntries(Object.entries(days).filter(([date]) => date >= cutoff));
}

function isWithinRetention(event, now, hours) {
  const createdAt = Date.parse(event?.createdAt || "");
  return Number.isFinite(createdAt) && createdAt <= now.getTime() && now.getTime() - createdAt <= hours * 3_600_000;
}

function normalizeCategory(value) {
  const category = normalizeText(value).toLowerCase();
  return Object.hasOwn(DEFAULT_CATEGORY_LIMITS, category) ? category : "guardian";
}

function normalizePriority(value) {
  const priority = normalizeText(value).toLowerCase();
  return ["normal", "high", "hard_boundary", "required"].includes(priority) ? priority : "normal";
}

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function localDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(dateText, offset) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

module.exports = {
  DEFAULT_CATEGORY_LIMITS,
  ProactiveInterventionCoordinator,
};
