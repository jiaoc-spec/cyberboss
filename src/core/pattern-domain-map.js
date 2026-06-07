// Maps source domain → target pattern domain keywords (substring match).
// Each entry lists the pattern domain fragments that are meaningful receivers
// for evidence from that source domain.
const DOMAIN_MAP = {
  health:               ["health", "night-shift", "recovery", "fitness"],
  sport:                ["health", "night-shift", "recovery", "fitness"],
  exercise:             ["health", "night-shift", "recovery"],
  recovery:             ["recovery", "night-shift", "health", "energy"],
  learning:             ["learning", "night-shift", "workload", "study"],
  englisch:             ["learning", "night-shift", "workload"],
  deutsch:              ["learning", "night-shift", "workload"],
  python:               ["learning", "workload", "tech"],
  career:               ["career", "work", "workload", "project"],
  "decision-patterns":  ["career", "work", "tools", "study", "project", "decision"],
  decision:             ["career", "work", "tools", "study", "project"],
  "shift-rating":       ["recovery", "night-shift", "energy", "fatigue"],
  fatigue:              ["recovery", "night-shift", "energy"],
  energy:               ["energy", "night-shift", "recovery", "health"],
};

function resolveTargetKeywords(sourceDomain) {
  const key = String(sourceDomain || "").toLowerCase().trim();
  if (!key) {
    return null;
  }
  if (DOMAIN_MAP[key]) {
    return DOMAIN_MAP[key];
  }
  for (const [mapKey, keywords] of Object.entries(DOMAIN_MAP)) {
    if (key.includes(mapKey) || mapKey.includes(key)) {
      return keywords;
    }
  }
  return null;
}

function matchPatternsByDomain(patterns, sourceDomain) {
  const keywords = resolveTargetKeywords(sourceDomain);
  if (!keywords || !Array.isArray(patterns)) {
    return [];
  }
  return patterns.filter((pattern) => {
    const d = String(pattern.domain || "").toLowerCase();
    return keywords.some((kw) => d.includes(kw));
  });
}

module.exports = { resolveTargetKeywords, matchPatternsByDomain };
