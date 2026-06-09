#!/usr/bin/env node
"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { checkReviewStatus, formatStatusReport } = require("../src/services/daily-review-check");

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
  text: buildBackfillMessage(date),
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

function buildBackfillMessage(targetDate) {
  return `[BACKFILL REQUEST date=${targetDate}] [COMPLEX_TASK requires_tools=true no_deepseek_fallback=true]

如果你是 DeepSeek fallback 而非主 runtime（Codex/Claude），请直接回复 {"action":"silent"}，不要生成任何内容。此任务需要文件读写工具才能正确执行。

---

请补生成 ${targetDate} 的 Obsidian Daily Review / 昨日时间轴报表。

数据源（按优先级读取）：
1. ~/.cyberboss/daily-inbox/${targetDate}.md
2. ~/.cyberboss/apple-calendar-cache.json（过滤 ${targetDate} 的事件）
3. ~/.cyberboss/missing-context-state.json（该日期的回答）
4. ~/.cyberboss/critical-habits-state.json（Level A/B/C）
5. ~/.cyberboss/shift-rating-state.json
6. ~/.cyberboss/pattern-ledger.json
7. ~/.cyberboss/wins-ledger.json
8. ~/.cyberboss/decision-journal.json

Obsidian 目标文件：03. 🔵 Tagebuch/01. 日记/${targetDate}.md
- 如文件已有"待午夜后自动生成"占位符，整体填充
- 如文件已有部分内容，追加缺失 section，不要删除已有内容
- 写入前不需要备份（iCloud 会自动保留版本）

原则：Meaning over Activity，不写 debug/技术日志噪音，缺失信息标记 unknown，重点帮助理解那一天。`;
}
