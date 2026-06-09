const HABITS = [
  { task: "Sport", domain: "health", patterns: [/运动/, /sport/i, /跑步/, /跑了/, /健身/, /散步/, /锻炼/] },
  { task: "Englisch", domain: "learning", patterns: [/英语/, /englisch/i, /english/i] },
  { task: "Deutsch", domain: "learning", patterns: [/德语/, /deutsch/i] },
  { task: "Praxisanleitung", domain: "career", patterns: [/praxisanleitung/i, /实践指导/] },
  { task: "Wundmanagement", domain: "career", patterns: [/wundmanagement/i, /伤口管理/] },
  { task: "Python", domain: "learning", patterns: [/python/i] },
];

const COMPLETION_WORDS = [
  "完成了", "做完了", "学完了", "搞定了", "结束了",
  "做了", "学了", "上了", "练了", "跑了", "走了",
];

const NEGATION_PATTERNS = [/还没/, /没有/, /没做/, /没学/, /没去/, /打算/, /要去/, /准备/, /不想/];

const SUCCESS_FACTOR_OPTIONS = [
  "1. 下班后马上开始",
  "2. 任务被拆小了",
  "3. 有提醒",
  "4. 今天精力比较好",
  "5. 环境合适",
  "6. 其他",
].join("\n");

const SUCCESS_FACTOR_MAP = {
  "1": "right_after_work",
  "2": "small_chunk",
  "3": "had_reminder",
  "4": "energy_good",
  "5": "good_environment",
  "6": "other",
};

function detectWinTrigger(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return null;
  }
  if (NEGATION_PATTERNS.some((re) => re.test(normalized))) {
    return null;
  }
  const hasCompletion = COMPLETION_WORDS.some((word) => normalized.includes(word));
  if (!hasCompletion) {
    return null;
  }
  for (const habit of HABITS) {
    if (habit.patterns.some((re) => re.test(normalized))) {
      return { task: habit.task, domain: habit.domain };
    }
  }
  return null;
}

function buildWinsPrompt() {
  return `这次能完成，主要是什么帮到你了？\n${SUCCESS_FACTOR_OPTIONS}`;
}

// Parses replies like "2", "2和3", "2 还有3", "2+3", "6. 精力太好了"
// Returns { success_factor, note } or null if no valid digit found.
function parseWinsResponse(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return null;
  }
  const digits = [...normalized.matchAll(/[1-6]/g)].map((m) => m[0]);
  if (!digits.length) {
    return null;
  }
  const primaryFactor = SUCCESS_FACTOR_MAP[digits[0]];
  if (!primaryFactor) {
    return null;
  }
  const additionalFactors = digits.slice(1)
    .map((d) => SUCCESS_FACTOR_MAP[d])
    .filter(Boolean);
  const freeText = normalized
    .replace(/[1-6]/g, "")
    .replace(/[和还有也+、，,。.：:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const noteParts = [...additionalFactors];
  if (freeText) {
    noteParts.push(freeText);
  }
  return {
    success_factor: primaryFactor,
    note: noteParts.join("; "),
  };
}

module.exports = { detectWinTrigger, buildWinsPrompt, parseWinsResponse };
