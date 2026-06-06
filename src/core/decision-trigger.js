const TRIGGER_PHRASES = [
  "我决定",
  "我选择了",
  "我选择",
  "我打算",
  "暂时不",
  "不马上",
  "我在纠结",
  "要不要",
];

// "我先X" triggers only when X is not an immediate physical action
const WO_XIAN_RE = /我先(?!去|来|把|做|吃|回|跑|睡|洗|喝)/;

const TRIVIAL_PATTERNS = [
  /吃什么/,
  /穿什么/,
  /走哪条/,
  /去哪里吃/,
  /点什么/,
];

const DECISION_TRIGGER_ANNOTATION = [
  "[SYSTEM: A decision trigger phrase was detected.",
  "The bridge has already sent the user a Decision Journal prompt directly.",
  "Do NOT ask about Decision Journal again.",
  "Give only your normal reply.]",
].join(" ");

function detectDecisionTrigger(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return false;
  }
  const hasTrigger = TRIGGER_PHRASES.some((phrase) => normalized.includes(phrase))
    || WO_XIAN_RE.test(normalized);
  if (!hasTrigger) {
    return false;
  }
  return !TRIVIAL_PATTERNS.some((re) => re.test(normalized));
}

function buildDecisionTriggerAnnotation() {
  return DECISION_TRIGGER_ANNOTATION;
}

module.exports = { detectDecisionTrigger, buildDecisionTriggerAnnotation };
