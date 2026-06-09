function resolveUserPronoun(gender) {
  const normalized = String(gender || "").trim().toLowerCase();
  if (normalized === "male" || normalized === "man" || normalized === "m" || normalized === "男") {
    return "他";
  }
  if (normalized === "neutral" || normalized === "nonbinary" || normalized === "nb" || normalized === "ta") {
    return "TA";
  }
  return "她";
}

function renderInstructionTemplate(template, config = {}) {
  const userName = String(config?.userName || "").trim() || "用户";
  const pronoun = resolveUserPronoun(config?.userGender);
  const uncertaintyPolicy = config?.askWhenUncertain === false
    ? "If information is missing, mark it as unknown instead of asking follow-up questions unless the user explicitly requests precision."
    : "When diary, timeline, learning statistics, workout statistics, mood/energy inference, or weekly review data is unclear, do not invent details. If the missing detail is important for a reliable record, ask the user one short follow-up question. If it is not important, mark it as 未记录 / unknown and continue.";
  return String(template || "")
    .replaceAll("{{USER_NAME}}", userName)
    .replaceAll("{{UNCERTAINTY_POLICY}}", uncertaintyPolicy)
    .replaceAll("她", pronoun);
}

module.exports = {
  renderInstructionTemplate,
  resolveUserPronoun,
};
