const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_GUIDE_THRESHOLD = 3;

const DOMAIN_LABELS = {
  learning_method: "学习方法",
  work_nursing: "工作 / 护理",
  body_energy: "身体 / 能量",
  emotion_relationship: "情绪 / 关系",
  executive_function: "执行功能",
  long_term_identity: "长期身份 / 目标",
  language: "语言",
  career: "职业发展",
  health: "健康",
  other: "其他",
};

class ExperienceLedgerService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.filePath = this.config.experienceLedgerFile;
    this.guideThreshold = normalizePositiveInteger(this.config.experienceGuideThreshold) || DEFAULT_GUIDE_THRESHOLD;
  }

  read(args = {}) {
    const ledger = this.loadLedger();
    const filters = normalizeFilters(args);
    const experiences = ledger.experiences
      .filter((item) => matchesFilters(item, filters))
      .sort(compareExperiences);
    const guides = ledger.guides
      .filter((item) => matchesFilters(item, filters))
      .sort(compareGuides);
    return {
      filePath: this.filePath,
      generatedAt: new Date().toISOString(),
      schemaVersion: ledger.schemaVersion,
      experiences: filters.limit ? experiences.slice(0, filters.limit) : experiences,
      guides: filters.limit ? guides.slice(0, filters.limit) : guides,
      candidates: this.guideCandidates(ledger),
      stats: buildStats(ledger, this.guideThreshold),
      count: experiences.length,
      totalCount: ledger.experiences.length,
    };
  }

  record(args = {}) {
    const now = new Date().toISOString();
    const ledger = this.loadLedger();
    const incoming = normalizeExperienceInput(args, now);
    const existingIndex = findExistingExperienceIndex(ledger.experiences, incoming);
    const previous = existingIndex >= 0 ? ledger.experiences[existingIndex] : null;
    const experience = previous
      ? mergeExperience(previous, incoming, now)
      : createExperience(incoming, now);

    if (existingIndex >= 0) {
      ledger.experiences[existingIndex] = experience;
    } else {
      ledger.experiences.push(experience);
    }

    recomputeExperienceStatuses(ledger, this.guideThreshold);
    ledger.updatedAt = now;
    this.saveLedger(ledger);
    return {
      filePath: this.filePath,
      created: existingIndex < 0,
      experience: ledger.experiences.find((item) => item.id === experience.id),
      candidates: this.guideCandidates(ledger),
      stats: buildStats(ledger, this.guideThreshold),
    };
  }

  createGuide(args = {}) {
    const now = new Date().toISOString();
    const ledger = this.loadLedger();
    const guide = normalizeGuideInput(args, now);
    const existingIndex = findExistingGuideIndex(ledger.guides, guide);
    if (existingIndex >= 0) {
      ledger.guides[existingIndex] = mergeGuide(ledger.guides[existingIndex], guide, now);
    } else {
      ledger.guides.push(createGuide(guide, now));
    }
    recomputeExperienceStatuses(ledger, this.guideThreshold);
    ledger.updatedAt = now;
    this.saveLedger(ledger);
    return {
      filePath: this.filePath,
      created: existingIndex < 0,
      guide: existingIndex >= 0 ? ledger.guides[existingIndex] : ledger.guides.at(-1),
      stats: buildStats(ledger, this.guideThreshold),
    };
  }

  buildDashboardMarkdown(args = {}) {
    const ledger = this.loadLedger();
    const threshold = normalizePositiveInteger(args.guideThreshold) || this.guideThreshold;
    recomputeExperienceStatuses(ledger, threshold);
    const stats = buildStats(ledger, threshold);
    const candidates = this.guideCandidates(ledger, { threshold });
    const dailyPrinciple = pickDailyPrinciple(ledger.experiences, args.date || new Date());
    const domainLines = Object.keys(DOMAIN_LABELS).map((domain) => {
      const items = ledger.experiences
        .filter((item) => item.domain === domain)
        .sort(compareExperiences)
        .slice(0, 5);
      if (!items.length) return "";
      return [
        `### ${DOMAIN_LABELS[domain]}`,
        ...items.map((item) => `- ${formatExperienceLine(item)}`),
        "",
      ].join("\n");
    }).filter(Boolean);
    const guideLines = ledger.guides.length
      ? ledger.guides.sort(compareGuides).slice(0, 12).map((guide) => `- **${guide.title}**：${guide.defaultAction || guide.summary || "已形成行动指南"}${guide.minimumVersion ? `；最小版本：${guide.minimumVersion}` : ""}`)
      : ["- 暂无已生成行动指南。"];
    const candidateLines = candidates.length
      ? candidates.slice(0, 12).map((candidate) => `- **${DOMAIN_LABELS[candidate.domain] || candidate.domain} / ${candidate.theme}**：${candidate.count} 条经验，适合沉淀行动指南。`)
      : ["- 暂无达到阈值的行动指南候选。"];

    return [
      "# 个人经验复利看板",
      "",
      "> CyberBoss 自动从每日/每周/月度复盘中提取可复用经验。这里不是原始聊天仓库，而是经验、原则和行动指南的沉淀区。",
      "",
      "## 今日原则",
      "",
      dailyPrinciple ? `> ${formatExperienceLine(dailyPrinciple)}` : "> 暂无可轮换原则。复盘积累后这里会自动显示一条经验。",
      "",
      "## 经验资产概览",
      "",
      `- 总经验：${stats.total} 条`,
      `- 原则：${stats.byType.principle || 0} 条`,
      `- 经验：${stats.byType.experience || 0} 条`,
      `- 洞察：${stats.byType.insight || 0} 条`,
      `- 行动指南：${ledger.guides.length} 条`,
      `- 行动指南候选阈值：同一主题 ${threshold} 条`,
      "",
      "## 可沉淀行动指南候选",
      "",
      ...candidateLines,
      "",
      "## 已形成行动指南",
      "",
      ...guideLines,
      "",
      "## 按领域聚合",
      "",
      ...(domainLines.length ? domainLines : ["暂无经验条目。", ""]),
      "## 使用规则",
      "",
      "- Daily Review 后只沉淀高信号经验，不把流水账和后台处理记录放进来。",
      "- 同一主题重复出现后，才升级成行动指南候选。",
      "- 行动指南用于未来相似情境的 just-in-time recall，不用于制造更多提醒压力。",
      "",
      `更新时间：${new Date().toISOString()}`,
    ].join("\n");
  }

  guideCandidates(ledger = this.loadLedger(), { threshold = this.guideThreshold } = {}) {
    const groups = groupExperiences(ledger.experiences);
    const guideKeys = new Set(ledger.guides.map((guide) => canonicalThemeKey(guide)));
    return [...groups.values()]
      .filter((group) => group.items.length >= threshold && !guideKeys.has(group.key))
      .map((group) => ({
        domain: group.domain,
        themeKey: group.themeKey,
        theme: group.theme,
        count: group.items.length,
        latestDate: latestTextDate(...group.items.map((item) => item.date)),
        experienceIds: group.items.map((item) => item.id),
        suggestedTitle: suggestGuideTitle(group),
      }))
      .sort((left, right) => right.count - left.count || normalizeText(right.latestDate).localeCompare(normalizeText(left.latestDate)));
  }

  loadLedger() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return normalizeLedger(parsed);
    } catch {
      return normalizeLedger({});
    }
  }

  saveLedger(ledger) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(normalizeLedger(ledger), null, 2)}\n`, "utf8");
  }
}

function normalizeLedger(value) {
  return {
    schemaVersion: Number.isInteger(value?.schemaVersion) ? value.schemaVersion : DEFAULT_SCHEMA_VERSION,
    updatedAt: normalizeText(value?.updatedAt),
    experiences: Array.isArray(value?.experiences)
      ? value.experiences.map(normalizeStoredExperience).filter(Boolean)
      : [],
    guides: Array.isArray(value?.guides)
      ? value.guides.map(normalizeStoredGuide).filter(Boolean)
      : [],
  };
}

function normalizeStoredExperience(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lesson = normalizeText(value.lesson);
  if (!lesson) return null;
  const domain = normalizeDomain(value.domain);
  const themeKey = normalizeThemeKey(value.themeKey || value.theme || value.title || value.tags?.[0] || lesson);
  return {
    id: normalizeText(value.id) || stableId("exp", [value.date, domain, themeKey, lesson].join(":")),
    date: normalizeDate(value.date),
    domain,
    type: normalizeType(value.type),
    title: normalizeText(value.title) || trimText(lesson, 60),
    theme: normalizeText(value.theme) || humanizeThemeKey(themeKey),
    themeKey,
    situation: normalizeText(value.situation),
    lesson,
    nextAction: normalizeText(value.nextAction),
    evidence: normalizeText(value.evidence),
    source: normalizeText(value.source) || "review",
    sourcePath: normalizeText(value.sourcePath),
    tags: normalizeTags(value.tags),
    status: normalizeExperienceStatus(value.status),
    createdAt: normalizeText(value.createdAt),
    updatedAt: normalizeText(value.updatedAt),
  };
}

function normalizeExperienceInput(args, now) {
  const lesson = normalizeText(args.lesson);
  if (!lesson) {
    throw new Error("Experience lesson is required.");
  }
  const domain = normalizeDomain(args.domain);
  const themeKey = normalizeThemeKey(args.themeKey || args.theme || args.title || firstTag(args.tags) || lesson);
  return {
    id: normalizeText(args.id),
    date: normalizeDate(args.date) || now.slice(0, 10),
    domain,
    type: normalizeType(args.type),
    title: normalizeText(args.title) || trimText(lesson, 60),
    theme: normalizeText(args.theme) || humanizeThemeKey(themeKey),
    themeKey,
    situation: normalizeText(args.situation),
    lesson,
    nextAction: normalizeText(args.nextAction),
    evidence: normalizeText(args.evidence),
    source: normalizeText(args.source) || "daily-review",
    sourcePath: normalizeText(args.sourcePath),
    tags: normalizeTags(args.tags),
    status: normalizeExperienceStatus(args.status),
    createdAt: now,
    updatedAt: now,
  };
}

function createExperience(input, now) {
  return {
    ...input,
    id: input.id || stableId("exp", [input.date, input.domain, input.themeKey, input.lesson].join(":")),
    createdAt: now,
    updatedAt: now,
  };
}

function mergeExperience(previous, incoming, now) {
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(incoming).filter(([key, value]) => {
      if (["id", "createdAt"].includes(key)) return false;
      if (Array.isArray(value)) return value.length > 0;
      return normalizeText(value);
    })),
    tags: mergeTags(previous.tags, incoming.tags),
    updatedAt: now,
  };
}

function normalizeStoredGuide(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title = normalizeText(value.title);
  const defaultAction = normalizeText(value.defaultAction);
  if (!title && !defaultAction) return null;
  const domain = normalizeDomain(value.domain);
  const themeKey = normalizeThemeKey(value.themeKey || value.theme || title || defaultAction);
  return {
    id: normalizeText(value.id) || stableId("guide", `${domain}:${themeKey}`),
    domain,
    title: title || humanizeThemeKey(themeKey),
    theme: normalizeText(value.theme) || humanizeThemeKey(themeKey),
    themeKey,
    trigger: normalizeText(value.trigger),
    summary: normalizeText(value.summary),
    defaultAction,
    minimumVersion: normalizeText(value.minimumVersion),
    notToDo: normalizeText(value.notToDo),
    warnings: normalizeTextArray(value.warnings),
    evidenceIds: normalizeTextArray(value.evidenceIds),
    status: normalizeGuideStatus(value.status),
    createdAt: normalizeText(value.createdAt),
    updatedAt: normalizeText(value.updatedAt),
  };
}

function normalizeGuideInput(args, now) {
  const domain = normalizeDomain(args.domain);
  const title = normalizeText(args.title);
  const defaultAction = normalizeText(args.defaultAction);
  if (!title && !defaultAction) {
    throw new Error("Experience guide requires title or defaultAction.");
  }
  const themeKey = normalizeThemeKey(args.themeKey || args.theme || title || defaultAction);
  return {
    id: normalizeText(args.id),
    domain,
    title: title || humanizeThemeKey(themeKey),
    theme: normalizeText(args.theme) || humanizeThemeKey(themeKey),
    themeKey,
    trigger: normalizeText(args.trigger),
    summary: normalizeText(args.summary),
    defaultAction,
    minimumVersion: normalizeText(args.minimumVersion),
    notToDo: normalizeText(args.notToDo),
    warnings: normalizeTextArray(args.warnings),
    evidenceIds: normalizeTextArray(args.evidenceIds),
    status: normalizeGuideStatus(args.status),
    createdAt: now,
    updatedAt: now,
  };
}

function createGuide(input, now) {
  return {
    ...input,
    id: input.id || stableId("guide", `${input.domain}:${input.themeKey}`),
    createdAt: now,
    updatedAt: now,
  };
}

function mergeGuide(previous, incoming, now) {
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(incoming).filter(([key, value]) => {
      if (["id", "createdAt"].includes(key)) return false;
      if (Array.isArray(value)) return value.length > 0;
      return normalizeText(value);
    })),
    warnings: mergeTextArrays(previous.warnings, incoming.warnings),
    evidenceIds: mergeTextArrays(previous.evidenceIds, incoming.evidenceIds),
    updatedAt: now,
  };
}

function recomputeExperienceStatuses(ledger, threshold) {
  const groups = groupExperiences(ledger.experiences);
  const guideKeys = new Set(ledger.guides.map((guide) => canonicalThemeKey(guide)));
  for (const group of groups.values()) {
    const hasGuide = guideKeys.has(group.key);
    const status = hasGuide
      ? "guide_created"
      : group.items.length >= threshold
        ? "guide_candidate"
        : group.items.length >= 2
          ? "recurring"
          : "seed";
    for (const item of group.items) {
      item.status = status;
    }
  }
}

function groupExperiences(experiences) {
  const map = new Map();
  for (const item of experiences) {
    const key = canonicalThemeKey(item);
    const existing = map.get(key) || {
      key,
      domain: item.domain,
      themeKey: item.themeKey,
      theme: item.theme,
      items: [],
    };
    existing.items.push(item);
    map.set(key, existing);
  }
  return map;
}

function buildStats(ledger, threshold) {
  return {
    total: ledger.experiences.length,
    guideThreshold: threshold,
    byDomain: countBy(ledger.experiences, (item) => item.domain),
    byType: countBy(ledger.experiences, (item) => item.type),
    byStatus: countBy(ledger.experiences, (item) => item.status),
    guideCount: ledger.guides.length,
  };
}

function normalizeFilters(args = {}) {
  return {
    domain: normalizeText(args.domain) ? normalizeDomain(args.domain) : "",
    status: normalizeText(args.status),
    type: normalizeText(args.type) ? normalizeType(args.type) : "",
    tag: normalizeText(args.tag).toLowerCase(),
    query: normalizeText(args.query).toLowerCase(),
    limit: normalizePositiveInteger(args.limit),
  };
}

function matchesFilters(item, filters) {
  if (filters.domain && item.domain !== filters.domain) return false;
  if (filters.status && item.status !== filters.status) return false;
  if (filters.type && item.type !== filters.type) return false;
  if (filters.tag && !(item.tags || []).some((tag) => tag.toLowerCase() === filters.tag)) return false;
  if (filters.query) {
    const haystack = [
      item.title,
      item.theme,
      item.situation,
      item.lesson,
      item.nextAction,
      item.evidence,
      item.summary,
      item.defaultAction,
      ...(item.tags || []),
    ].join("\n").toLowerCase();
    if (!haystack.includes(filters.query)) return false;
  }
  return true;
}

function findExistingExperienceIndex(experiences, incoming) {
  if (incoming.id) {
    const byId = experiences.findIndex((item) => item.id === incoming.id);
    if (byId >= 0) return byId;
  }
  const id = incoming.id || stableId("exp", [incoming.date, incoming.domain, incoming.themeKey, incoming.lesson].join(":"));
  return experiences.findIndex((item) => item.id === id);
}

function findExistingGuideIndex(guides, incoming) {
  if (incoming.id) {
    const byId = guides.findIndex((item) => item.id === incoming.id);
    if (byId >= 0) return byId;
  }
  const key = canonicalThemeKey(incoming);
  return guides.findIndex((item) => canonicalThemeKey(item) === key);
}

function canonicalThemeKey(item) {
  return `${normalizeDomain(item.domain)}:${normalizeThemeKey(item.themeKey || item.theme || item.title || item.lesson)}`;
}

function stableId(prefix, text) {
  const digest = crypto.createHash("sha1").update(normalizeText(text).toLowerCase()).digest("hex").slice(0, 10);
  return `${prefix}_${digest}`;
}

function suggestGuideTitle(group) {
  return `${DOMAIN_LABELS[group.domain] || group.domain}：${group.theme}`;
}

function pickDailyPrinciple(experiences, date) {
  const principles = experiences
    .filter((item) => item.type === "principle" || item.status === "guide_created" || item.status === "guide_candidate")
    .sort(compareExperiences);
  if (!principles.length) return null;
  const day = dayOfYear(date instanceof Date ? date : new Date(String(date)));
  return principles[day % principles.length];
}

function formatExperienceLine(item) {
  const parts = [
    item.lesson,
    item.nextAction ? `行动：${item.nextAction}` : "",
    item.sourcePath ? `来源：[[${path.basename(item.sourcePath, ".md")}]]` : "",
  ].filter(Boolean);
  return parts.join("；");
}

function compareExperiences(left, right) {
  return normalizeText(right.date).localeCompare(normalizeText(left.date))
    || normalizeText(right.updatedAt).localeCompare(normalizeText(left.updatedAt))
    || left.title.localeCompare(right.title);
}

function compareGuides(left, right) {
  return normalizeGuideStatus(left.status).localeCompare(normalizeGuideStatus(right.status))
    || normalizeText(right.updatedAt).localeCompare(normalizeText(left.updatedAt))
    || left.title.localeCompare(right.title);
}

function normalizeDomain(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[-\s]+/g, "_");
  const aliases = {
    learning: "learning_method",
    study: "learning_method",
    work: "work_nursing",
    nursing: "work_nursing",
    body: "body_energy",
    energy: "body_energy",
    recovery: "body_energy",
    emotion: "emotion_relationship",
    relationship: "emotion_relationship",
    executive: "executive_function",
    productivity: "executive_function",
    identity: "long_term_identity",
    goal: "long_term_identity",
  };
  const candidate = aliases[normalized] || normalized;
  return Object.prototype.hasOwnProperty.call(DOMAIN_LABELS, candidate) ? candidate : "other";
}

function normalizeType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["principle", "经验原则", "原则"].includes(normalized)) return "principle";
  if (["insight", "洞察"].includes(normalized)) return "insight";
  return "experience";
}

function normalizeExperienceStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["seed", "recurring", "guide_candidate", "guide_created", "archived"].includes(normalized) ? normalized : "seed";
}

function normalizeGuideStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["draft", "active", "retired"].includes(normalized) ? normalized : "active";
}

function normalizeThemeKey(value) {
  const text = normalizeText(value)
    .toLowerCase()
    .replace(/[#，。！？；：、,.!?;:()[\]{}"'“”‘’]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text.slice(0, 80) || "general";
}

function humanizeThemeKey(value) {
  return normalizeText(value).replace(/[-_]+/g, " ").trim() || "general";
}

function normalizeTags(value) {
  return normalizeTextArray(value).map((item) => item.replace(/^#经验\//, "").replace(/^#/, "")).filter(Boolean);
}

function mergeTags(left, right) {
  return mergeTextArrays(normalizeTags(left), normalizeTags(right));
}

function normalizeTextArray(value) {
  if (Array.isArray(value)) return [...new Set(value.map(normalizeText).filter(Boolean))];
  const text = normalizeText(value);
  return text ? [text] : [];
}

function mergeTextArrays(left, right) {
  return [...new Set([...normalizeTextArray(left), ...normalizeTextArray(right)])];
}

function firstTag(tags) {
  return normalizeTextArray(tags)[0] || "";
}

function normalizeDate(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function latestTextDate(...dates) {
  return dates.map(normalizeText).filter(Boolean).sort().at(-1) || "";
}

function countBy(items, project) {
  const counts = {};
  for (const item of items) {
    const key = project(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function dayOfYear(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 0;
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / 86_400_000);
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function trimText(value, max) {
  const text = normalizeText(value);
  return text.length <= max ? text : `${text.slice(0, max - 3).trim()}...`;
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

module.exports = {
  ExperienceLedgerService,
  DOMAIN_LABELS,
};
