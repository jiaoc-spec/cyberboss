const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;

// Campaigns are time-bounded goal containers (a semester, an exam period, a
// thesis sprint) layered above the timeless Level A/B/C habits. A deadline can
// reference a habit id; when the deadline is near, the habit is boosted into
// the daily Level A guardian set.
class CampaignService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.filePath = this.config.campaignsFile;
  }

  async upsert({ id = "", name = "", startDate = "", endDate = "", deadlines = [], note = "" } = {}) {
    if (!String(name || "").trim()) {
      throw new Error("campaign_set: name is required.");
    }
    const now = new Date();
    const state = this._load();
    const normalizedId = String(id || "").trim();
    const existing = normalizedId ? state.campaigns.find((item) => item.id === normalizedId) : null;
    const campaign = {
      id: existing?.id || normalizedId || `cmp_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
      name: String(name).trim(),
      startDate: String(startDate || existing?.startDate || "").trim(),
      endDate: String(endDate || existing?.endDate || "").trim(),
      note: String(note || existing?.note || "").trim(),
      deadlines: normalizeDeadlines(deadlines.length ? deadlines : existing?.deadlines || []),
      createdAt: existing?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
    };
    if (existing) {
      state.campaigns = state.campaigns.map((item) => (item.id === campaign.id ? campaign : item));
    } else {
      state.campaigns.push(campaign);
    }
    this._save(state);
    return campaign;
  }

  async status({ date = "" } = {}) {
    const today = String(date || "").trim() || formatDate(new Date(), this.timeZone());
    const state = this._load();
    const active = state.campaigns.filter((item) =>
      (!item.startDate || item.startDate <= today) && (!item.endDate || item.endDate >= today));
    const daysBefore = this.boostDaysBefore();
    const upcoming = [];
    for (const campaign of active) {
      for (const deadline of campaign.deadlines) {
        const days = daysBetween(today, deadline.date);
        if (days !== null && days >= 0) {
          upcoming.push({ campaign: campaign.name, campaignId: campaign.id, ...deadline, daysLeft: days, boosting: Boolean(deadline.habitId) && days <= daysBefore });
        }
      }
    }
    upcoming.sort((left, right) => left.daysLeft - right.daysLeft);
    return { date: today, activeCampaigns: active, upcomingDeadlines: upcoming };
  }

  // Habit ids that should temporarily join the daily Level A guardian set
  // because a campaign deadline referencing them is near.
  boostedHabitIds(date = "") {
    try {
      const today = String(date || "").trim() || formatDate(new Date(), this.timeZone());
      const state = this._load();
      const daysBefore = this.boostDaysBefore();
      const ids = new Set();
      for (const campaign of state.campaigns) {
        if (campaign.startDate && campaign.startDate > today) continue;
        if (campaign.endDate && campaign.endDate < today) continue;
        for (const deadline of campaign.deadlines) {
          if (!deadline.habitId) continue;
          const days = daysBetween(today, deadline.date);
          if (days !== null && days >= 0 && days <= daysBefore) {
            ids.add(deadline.habitId);
          }
        }
      }
      return [...ids];
    } catch {
      return [];
    }
  }

  boostDaysBefore() {
    const value = Number(this.config.campaignBoostDaysBefore);
    return Number.isFinite(value) && value > 0 ? value : 14;
  }

  timeZone() {
    return this.config.timeZone || this.config.diaryTimeZone || "UTC";
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || !Array.isArray(parsed.campaigns)) {
        return { schemaVersion: SCHEMA_VERSION, campaigns: [] };
      }
      return parsed;
    } catch {
      return { schemaVersion: SCHEMA_VERSION, campaigns: [] };
    }
  }

  _save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const data = { schemaVersion: SCHEMA_VERSION, ...state, updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function normalizeDeadlines(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      label: String(item?.label || "").trim(),
      date: String(item?.date || "").trim(),
      habitId: String(item?.habitId || "").trim(),
    }))
    .filter((item) => item.label && /^\d{4}-\d{2}-\d{2}$/.test(item.date));
}

function daysBetween(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T12:00:00Z`);
  const to = Date.parse(`${toDate}T12:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  return Math.round((to - from) / 86_400_000);
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

module.exports = { CampaignService };
