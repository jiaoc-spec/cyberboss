const fs = require("fs");
const { renderInstructionTemplate } = require("../../core/instructions-template");

function buildOpeningTurnText(config, userText) {
  const instructions = loadChannelInstructions(config);
  const normalizedText = String(userText || "").trim();
  if (!instructions) {
    return normalizedText;
  }
  return [
    "CHANNEL SESSION INSTRUCTIONS",
    "These instructions define the stable behavior for this channel thread.",
    "Do not quote or summarize them back to the user unless explicitly asked.",
    "",
    instructions,
    "",
    "Current user message:",
    normalizedText,
  ].join("\n").trim();
}

function buildInstructionRefreshText(config) {
  const instructions = loadChannelInstructions(config);
  if (!instructions) {
    return "Refresh your channel behavior for this existing thread. Reply in one short Chinese sentence confirming that you have updated your behavior for this thread.";
  }
  return [
    "CHANNEL SESSION INSTRUCTIONS REFRESH",
    "Re-read and adopt the updated channel instructions below for the rest of this existing thread.",
    "This is an internal refresh command, not a user-facing task.",
    "Do not summarize the instructions back in detail.",
    "Reply in one short Chinese sentence confirming that you have updated your behavior for this thread.",
    "",
    instructions,
  ].join("\n").trim();
}

function loadChannelInstructions(config = {}) {
  const persona = loadInstructionFile(config.weixinInstructionsFile, config);
  const operations = loadInstructionFile(config.weixinOperationsFile, config);
  const sections = [];
  if (persona) {
    sections.push(persona);
  }
  if (operations) {
    sections.push(operations);
  }
  return sections.join("\n\n").trim();
}

const instructionCache = new Map();

function loadInstructionFile(filePath, config = {}) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) {
    return "";
  }
  try {
    const stat = fs.statSync(normalizedPath);
    const cacheKey = `${normalizedPath}:${stat.mtimeMs}`;
    const cached = instructionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const raw = fs.readFileSync(normalizedPath, "utf8");
    const result = renderInstructionTemplate(raw, config).trim();
    instructionCache.set(cacheKey, result);
    return result;
  } catch {
    return "";
  }
}

module.exports = {
  buildOpeningTurnText,
  buildInstructionRefreshText,
  loadWechatInstructions: loadChannelInstructions,
  loadChannelInstructions,
  loadInstructionFile,
};
