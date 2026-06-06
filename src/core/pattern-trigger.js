const PATTERN_VIEW_TRIGGERS = [
  /看.*模式/, /模式.*列表/, /最近.*模式/, /查.*模式/, /有哪些模式/,
  /pattern list/i, /show pattern/i, /模式研究/, /规律有哪些/, /看看规律/,
];

function detectPatternViewTrigger(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return false;
  }
  return PATTERN_VIEW_TRIGGERS.some((re) => re.test(normalized));
}

function formatPatternList(patterns) {
  if (!Array.isArray(patterns) || !patterns.length) {
    return "Pattern Ledger 目前还没有记录。";
  }
  return patterns.map((p, i) => {
    const conf = p.confidence || "low";
    const status = p.status || "hypothesis";
    const evidenceCount = Array.isArray(p.evidence) ? p.evidence.length : 0;
    const interventionCount = Array.isArray(p.intervention_ideas) ? p.intervention_ideas.length : 0;
    return [
      `${i + 1}. ${p.title}`,
      `   域: ${p.domain} | 状态: ${status} | 置信: ${conf}`,
      `   证据: ${evidenceCount}条 | 干预建议: ${interventionCount}条`,
    ].join("\n");
  }).join("\n\n");
}

module.exports = { detectPatternViewTrigger, formatPatternList };
