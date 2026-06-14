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

复盘写作原则：
- 写给 Jane 的未来自己，不写给数据管道。
- 不要列后台处理痕迹：不要写"已删除"、"用户表述"、"未记录"、"data_quality_notes"、"工具失败"、"archive"、"同步"等实现细节，除非它直接影响生活洞察。
- 缺失信息只在影响判断时提一句；不要把 unknown 当成复盘主体。
- 每日复盘不是流水账，也不是完成/失败判决。重点回答：
  1. 今天什么真的影响了长期目标？
  2. 今天更了解了 Jane 的哪一个状态、模式或限制？
  3. 今天哪些事情应该进入周/月视角继续观察？
  4. 明天最小可回来的版本是什么？
- 对 habit 信息要结构化、保守：明确完成才写完成；没有证据就写未形成完成记录，不要把提醒、计划或意愿当成完成。
- 复盘正文优先使用这些 section：一天主线、自我理解、习惯和恢复、值得进入长期观察、明日最小延续。避免过多机械小标题。
- 使用 Be-Do-Have / Identity Ledger 视角：先写今天哪些"正在成为的人"获得了证据，再写对应行动。不要只列 habit 完成/未完成。至少检查四条身份主线：
  1. 健康、有体能、身体自主的人：Sport、健身、有氧操；塑形 / 身体结构维护：武当1+2、足弓、美容灯；不要把武当1+2或足弓算成 Sport
  2. 德语/英语能力优秀的人：英语发音、德语语法、德语影子跟读
  3. 护理科学家 / 教授 / 教师 / ANP / 研究者：Praxisanleitung、Wundmanagement、Python、Nursing Digest、Pflegewissenschaft、Literature Reading、Forschung
  4. 持续跳舞、有表达力和生命力的人：成品舞、基本功、有氧操、身体练习
- 对每条身份主线，区分：今天有证据、今天缺席、或数据不足。缺席不是失败；写成"这个身份今天没有获得新证据"，并给出明天/本周的最小行为版本。
- Meaning over Activity，不写 debug/技术日志噪音，重点帮助理解那一天。

Obsidian Tracker 义务：
- 如果当天能判断 habit 完成情况，请在"## 时间轴数据" JSON 中保留机器可读字段，便于 tracker 自动同步。
- 同时在 JSON 中保留可选的 identity_ledger 字段，便于周/月复盘聚合。示例：
  "identity_ledger": {
    "health_fitness": {"evidence": ["足弓"], "missing": ["正式训练"], "next_minimum": "5 分钟身体连续性"},
    "language": {"evidence": ["英语发音"], "missing": ["德语语法"], "next_minimum": "10 分钟德语语法"},
    "nursing_science": {"evidence": [], "missing": ["Nursing Digest"], "next_minimum": "读一段摘要"},
    "dance": {"evidence": [], "missing": ["成品舞"], "next_minimum": "跟一小段音乐"}
  }
- Tracker habit 名称只使用这些：
  Sport、冥想、英语发音、德语语法、德语影子跟读、武当1+2、足弓、健身、基本功、成品舞、有氧操、美容灯、Praxisanleitung、Wundmanagement、Python、Nursing Digest。
- Englisch 在 tracker 中具体指"英语发音"。
- Deutsch 在 tracker 中拆成"德语语法"和"德语影子跟读"；如果当天只知道笼统 Deutsch，不要编造成两个都完成。
- Energy、Mood、Shift Fatigue、Screen Time 是状态/指标，不是 habit。可以保留为 daily state 字段，但不要放进 tracker habit 列表。
- JSON 只放紧凑结构化数据；人类复盘不要解释同步过程。

全部完成后返回 {"action":"silent"}。只有在遇到无法自行解决的问题时才用 send_message 简短说明。`;
}

module.exports = { buildDailyReviewPrompt, DEFAULT_OBSIDIAN_DAILY_FOLDER };
