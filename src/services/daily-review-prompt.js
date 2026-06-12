const DEFAULT_OBSIDIAN_DAILY_FOLDER = "03. 🔵 Tagebuch/01. 日记";

function buildDailyReviewPrompt(targetDate, { obsidianDailyFolder = "", attempt = 0, reason = "scheduled" } = {}) {
  const folder = String(obsidianDailyFolder || "").trim() || DEFAULT_OBSIDIAN_DAILY_FOLDER;
  const attemptNote = attempt > 1
    ? `\n这是第 ${attempt} 次尝试（之前的尝试没有产生完整复盘）。请这次务必完成写入，不要只回复文本。`
    : "";
  return `[DAILY REVIEW PIPELINE date=${targetDate} reason=${reason}] [COMPLEX_TASK requires_tools=true no_deepseek_fallback=true]

如果你是 DeepSeek fallback 而非主 runtime（Codex/Claude），请直接回复 {"action":"silent"}，不要生成任何内容。此任务需要文件读写工具才能正确执行。
${attemptNote}
---

请生成 ${targetDate} 的 Obsidian Daily Review / 昨日时间轴报表。

数据源（按优先级读取）：
1. ~/.cyberboss/daily-inbox/${targetDate}.md（如不存在，读 ~/.cyberboss/daily-inbox-archive/${targetDate}.md）
2. ~/.cyberboss/apple-calendar-cache.json（过滤 ${targetDate} 的事件）
3. ~/.cyberboss/missing-context-state.json（该日期的回答）
4. ~/.cyberboss/critical-habits-state.json（Level A/B/C）
5. ~/.cyberboss/shift-rating-state.json
6. ~/.cyberboss/pattern-ledger.json
7. ~/.cyberboss/wins-ledger.json
8. ~/.cyberboss/decision-journal.json

Obsidian 目标文件：${folder}/${targetDate}.md
- 读取用 cyberboss_obsidian_note_read，写入必须用 cyberboss_obsidian_note_write（relativePath=${folder}/${targetDate}.md）
- 绝对不要用 shell、cat、sed 或 apply_patch 直接改 vault 文件——那会触发需要人工批准的沙箱审批，半夜没人批，流程就会卡住
- 如文件已有"待午夜后自动生成"占位符，用 mode=replace_placeholder 整体填充
- 如文件已有部分内容，用 mode=append 追加缺失 section，不要删除已有内容
- 必须包含 "## 每日复盘" section，写完后文件中不能再残留"待午夜后自动生成"占位符

Pattern Ledger 观察义务（这是长期记忆闭环的一部分）：
- 读取 pattern-ledger.json 里 status 为 hypothesis / active / confirmed 的 pattern
- 如果 ${targetDate} 的数据能回答某个 pattern 的 nextObservation，用 cyberboss_pattern_add_evidence 追加当天证据
- 不要为了凑证据而编造；没有相关数据就跳过

原则：Meaning over Activity，不写 debug/技术日志噪音，缺失信息标记 unknown，重点帮助理解那一天。

全部完成后返回 {"action":"silent"}。只有在遇到无法自行解决的问题时才用 send_message 简短说明。`;
}

module.exports = { buildDailyReviewPrompt, DEFAULT_OBSIDIAN_DAILY_FOLDER };
