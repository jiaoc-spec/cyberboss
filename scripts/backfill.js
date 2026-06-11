#!/usr/bin/env node
"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { checkReviewStatus, formatStatusReport } = require("../src/services/daily-review-check");
const { buildDailyReviewPrompt } = require("../src/services/daily-review-prompt");

const args = process.argv.slice(2);
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const force = args.includes("--force");

if (!date) {
  console.error("Usage: npm run backfill -- YYYY-MM-DD [--force]");
  console.error("Example: npm run backfill -- 2026-06-08");
  process.exit(1);
}

const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
const obsidianDailyNoteDir = process.env.CYBERBOSS_OBSIDIAN_DAILY_DIR || "";

const result = checkReviewStatus({ stateDir, obsidianDailyNoteDir, date });
console.log(formatStatusReport(result));
console.log();

if (result.obsidian.hasReviewContent && !force) {
  console.log("⚠️  Daily Review for this date appears complete.");
  console.log("   Use --force to regenerate anyway.");
  process.exit(0);
}

if (!result.inbox.found) {
  console.log("❌ No Daily Inbox found. Cannot backfill without source data.");
  process.exit(1);
}

const queueFile = path.join(stateDir, "system-message-queue.json");
const sessionsFile = path.join(stateDir, "sessions.json");

let accountId = "";
let senderId = "";
let workspaceRoot = "";

try {
  const sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
  const bindings = sessions.bindings || {};
  for (const binding of Object.values(bindings)) {
    if (binding.accountId && binding.senderId && binding.activeWorkspaceRoot) {
      accountId = binding.accountId;
      senderId = binding.senderId;
      workspaceRoot = binding.activeWorkspaceRoot;
      break;
    }
  }
} catch {}

if (!accountId || !senderId || !workspaceRoot) {
  console.log("❌ Could not read session info from sessions.json.");
  console.log("   Make sure CyberBoss has been started and used at least once.");
  process.exit(1);
}

let queue = { messages: [] };
try {
  const raw = JSON.parse(fs.readFileSync(queueFile, "utf8"));
  if (Array.isArray(raw?.messages)) queue = raw;
} catch {}

const message = {
  id: crypto.randomUUID(),
  accountId,
  senderId,
  workspaceRoot,
  text: buildDailyReviewPrompt(date, {
    obsidianDailyFolder: process.env.CYBERBOSS_OBSIDIAN_DAILY_FOLDER || "",
    reason: "backfill",
  }),
  createdAt: new Date().toISOString(),
};

queue.messages.push(message);
fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");

console.log(`✅ Backfill queued for ${date}`);
console.log(`   Message ID: ${message.id}`);
console.log(`   Account: ${accountId} | Sender: ${senderId}`);
console.log(`   Workspace: ${workspaceRoot}`);
console.log();
console.log("主 runtime（Codex）将在下次响应时生成 Daily Review。");
console.log("发送任意 Telegram 消息可触发立即处理。");
console.log();
console.log("⚠️  模型分工说明：");
console.log("   此任务需要 Codex（主 runtime）+ MCP 工具才能写入 Obsidian。");
console.log("   DeepSeek fallback 无法执行文件操作，会保持 silent 而不产生低质量输出。");
console.log("   如需立即高质量补跑，直接在 Claude Code 中告诉 Claude 补生成即可。");
