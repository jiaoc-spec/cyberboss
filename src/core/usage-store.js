const fs = require("fs");
const path = require("path");

class UsageStore {
  constructor({ filePath, timeZone = "", pricing = {} } = {}) {
    this.filePath = filePath;
    this.timeZone = normalizeText(timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    this.pricing = normalizePricing(pricing);
    this.state = readState(filePath);
  }

  recordRuntimeContext(context = {}) {
    const runtimeId = normalizeText(context.runtimeId);
    const threadId = normalizeText(context.threadId);
    if (!runtimeId || !threadId) {
      return null;
    }

    const totals = normalizeUsageTotals(context);
    if (!hasAnyUsage(totals)) {
      return null;
    }

    const lastKey = `${runtimeId}:${threadId}`;
    const previousRaw = this.state.lastTotals?.[lastKey] || null;
    if (!previousRaw) {
      this.state.lastTotals[lastKey] = totals;
      this.write();
      return null;
    }
    const previous = normalizeUsageTotals(previousRaw);
    const delta = subtractUsageTotals(totals, previous);
    this.state.lastTotals[lastKey] = totals;
    if (!hasAnyUsage(delta)) {
      this.write();
      return null;
    }

    const dayKey = localDateKey(new Date(), this.timeZone);
    const day = this.state.days[dayKey] || createEmptyUsageBucket();
    this.state.days[dayKey] = addUsageTotals(day, delta);
    this.write();
    return { date: dayKey, delta, totals };
  }

  summarize(now = new Date()) {
    const todayKey = localDateKey(now, this.timeZone);
    const weekKeys = collectPeriodKeys({
      days: this.state.days,
      startKey: startOfLocalWeekKey(now, this.timeZone),
      endKey: todayKey,
    });
    const monthKeys = collectPeriodKeys({
      days: this.state.days,
      startKey: todayKey.slice(0, 7) + "-01",
      endKey: todayKey,
    });

    const today = normalizeUsageTotals(this.state.days[todayKey] || {});
    const week = sumBuckets(this.state.days, weekKeys);
    const month = sumBuckets(this.state.days, monthKeys);
    return {
      timeZone: this.timeZone,
      pricing: this.pricing,
      today,
      week,
      month,
      todayCostUsd: estimateCostUsd(today, this.pricing),
      weekCostUsd: estimateCostUsd(week, this.pricing),
      monthCostUsd: estimateCostUsd(month, this.pricing),
    };
  }

  write() {
    if (!this.filePath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2) + "\n", "utf8");
  }
}

function readState(filePath) {
  const empty = { version: 1, days: {}, lastTotals: {} };
  if (!filePath) {
    return empty;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      version: 1,
      days: parsed?.days && typeof parsed.days === "object" ? parsed.days : {},
      lastTotals: parsed?.lastTotals && typeof parsed.lastTotals === "object" ? parsed.lastTotals : {},
    };
  } catch {
    return empty;
  }
}

function createEmptyUsageBucket() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function normalizeUsageTotals(value = {}) {
  const inputTokens = numberOrZero(value.inputTokens);
  const cachedInputTokens = numberOrZero(value.cachedInputTokens);
  const outputTokens = numberOrZero(value.outputTokens);
  const reasoningTokens = numberOrZero(value.reasoningTokens);
  const explicitTotal = numberOrZero(value.totalTokens || value.currentTokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: explicitTotal || inputTokens + cachedInputTokens + outputTokens + reasoningTokens,
  };
}

function addUsageTotals(left = {}, right = {}) {
  const a = normalizeUsageTotals(left);
  const b = normalizeUsageTotals(right);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function subtractUsageTotals(current = {}, previous = {}) {
  const a = normalizeUsageTotals(current);
  const b = normalizeUsageTotals(previous);
  return {
    inputTokens: positiveDelta(a.inputTokens, b.inputTokens),
    cachedInputTokens: positiveDelta(a.cachedInputTokens, b.cachedInputTokens),
    outputTokens: positiveDelta(a.outputTokens, b.outputTokens),
    reasoningTokens: positiveDelta(a.reasoningTokens, b.reasoningTokens),
    totalTokens: positiveDelta(a.totalTokens, b.totalTokens),
  };
}

function positiveDelta(current, previous) {
  const delta = numberOrZero(current) - numberOrZero(previous);
  return delta > 0 ? delta : 0;
}

function hasAnyUsage(value = {}) {
  const usage = normalizeUsageTotals(value);
  return usage.totalTokens > 0
    || usage.inputTokens > 0
    || usage.cachedInputTokens > 0
    || usage.outputTokens > 0
    || usage.reasoningTokens > 0;
}

function sumBuckets(days, keys) {
  return keys.reduce((total, key) => addUsageTotals(total, days[key] || {}), createEmptyUsageBucket());
}

function collectPeriodKeys({ days, startKey, endKey }) {
  return Object.keys(days || {})
    .filter((key) => key >= startKey && key <= endKey)
    .sort();
}

function localDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function startOfLocalWeekKey(date, timeZone) {
  const todayKey = localDateKey(date, timeZone);
  const utcNoon = new Date(`${todayKey}T12:00:00Z`);
  const day = utcNoon.getUTCDay() || 7;
  utcNoon.setUTCDate(utcNoon.getUTCDate() - day + 1);
  return localDateKey(utcNoon, timeZone);
}

function estimateCostUsd(usage = {}, pricing = {}) {
  const totals = normalizeUsageTotals(usage);
  const inputCost = totals.inputTokens * pricing.inputUsdPer1M / 1_000_000;
  const cachedCost = totals.cachedInputTokens * pricing.cachedInputUsdPer1M / 1_000_000;
  const outputCost = totals.outputTokens * pricing.outputUsdPer1M / 1_000_000;
  const reasoningCost = totals.reasoningTokens * pricing.reasoningUsdPer1M / 1_000_000;
  const itemized = inputCost + cachedCost + outputCost + reasoningCost;
  if (itemized > 0) {
    return itemized;
  }
  return totals.totalTokens * pricing.blendedUsdPer1M / 1_000_000;
}

function normalizePricing(pricing = {}) {
  return {
    inputUsdPer1M: numberOrZero(pricing.inputUsdPer1M),
    cachedInputUsdPer1M: numberOrZero(pricing.cachedInputUsdPer1M),
    outputUsdPer1M: numberOrZero(pricing.outputUsdPer1M),
    reasoningUsdPer1M: numberOrZero(pricing.reasoningUsdPer1M),
    blendedUsdPer1M: numberOrZero(pricing.blendedUsdPer1M) || 2,
  };
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  UsageStore,
  estimateCostUsd,
  localDateKey,
  normalizeUsageTotals,
};
