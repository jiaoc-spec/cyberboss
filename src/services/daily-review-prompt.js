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
7. ~/.cyberboss/experience-ledger.json
8. ~/.cyberboss/wins-ledger.json
9. ~/.cyberboss/decision-journal.json

Obsidian 目标文件：${folder}/${targetDate}.md
- 读取用 cyberboss_obsidian_note_read，写入必须用 cyberboss_obsidian_note_write（relativePath=${folder}/${targetDate}.md）
- 绝对不要用 shell、cat、sed 或 apply_patch 直接改 vault 文件——那会触发需要人工批准的沙箱审批，半夜没人批，流程就会卡住
- 同样绝对不要用 node、bash、python 或 heredoc 脚本去"调用"工具（例如 node -e 里 require/invokeTool）。直接把 cyberboss_obsidian_note_write 当成原生工具调用，参数用 relativePath/content/mode；任何把工具包进脚本再 exec 的做法都会触发审批并把代码泄漏给用户，严禁
- 如文件已有"待午夜后自动生成"占位符，用 mode=replace_placeholder 整体填充
- 如文件已有部分内容，用 mode=append 追加缺失 section，不要删除已有内容
- 必须包含 "## 每日复盘" section，写完后文件中不能再残留"待午夜后自动生成"占位符

Pattern Ledger 观察义务（这是长期记忆闭环的一部分）：
- 读取 pattern-ledger.json 里 status 为 hypothesis / active / confirmed 的 pattern
- 如果 ${targetDate} 的数据能回答某个 pattern 的 nextObservation，用 cyberboss_pattern_add_evidence 追加当天证据
- 不要为了凑证据而编造；没有相关数据就跳过

Experience Ledger 经验复利义务：
- Daily Review 写完后，从当天复盘中提取 0-3 条高信号经验，用 cyberboss_experience_record 记录。没有值得复用的经验就不要硬记。
- 只记录以后能复用的经验、原则或洞察，例如：重复踩坑、有效启动策略、恢复策略、工作/护理判断、学习方法、情绪/能量模式、长期身份相关原则。
- 不记录 raw chat、提醒本身、后台处理、同步、工具失败、taxonomy、debug、普通物流/日程信息。
- 使用固定 domain：learning_method、work_nursing、body_energy、emotion_relationship、executive_function、long_term_identity、language、career、health、other。
- theme 要稳定，便于聚合，例如 night-shift-recovery、worst-day-baseline、after-work-start、screen-time-friction。
- 如果同一 theme 达到候选阈值，先让 Experience Ledger 标为 guide_candidate；Daily Review 不必每天生成行动指南，优先留给 Weekly/Monthly Review 合并。

复盘写作原则：
- 写给 Jane 的未来自己，不写给数据管道。
- 不要列后台处理痕迹：不要写"已删除"、"用户表述"、"未记录"、"data_quality_notes"、"工具失败"、"archive"、"同步"等实现细节，除非它直接影响生活洞察。
- 缺失信息只在影响判断时提一句；不要把 unknown 当成复盘主体。
- 不要在同一篇复盘里先写"暂无值得保留的记录"、"暂无"、"待观察"，后文又写出明确完成、身体线索、职业信号或情绪事实；有证据就直接写证据，没证据就写"今天这条线没有新证据"或直接省略该小节。
- 不要用"待观察"批量填满小标题；只有当当天确实没有足够证据、但这件事值得进入周/月视角继续看时，才保留一句低权重假设。
- 每日复盘不是流水账，也不是完成/失败判决。重点回答：
  1. 今天什么真的影响了长期目标？
  2. 今天更了解了 Jane 的哪一个状态、模式或限制？
  3. 今天哪些事情应该进入周/月视角继续观察？
  4. 明天最小可回来的版本是什么？
- 一致性系统原则（来自 Jane 选择的 Second Brain 方向）：
  - 不把"没做到"写成性格问题或意志力失败；把它当作系统数据。
  - 优先观察行为而不是结果。结果慢，行为当天可见。
  - 检查今天是否至少有一个 Future Self Vote：一个支持未来身份的小行为。
  - 如果没有 Future Self Vote，写清楚最可能的阻碍和明天最低可执行版本，不要扩大成自责。
  - 复盘中尽量回答三个短反馈问题：今天什么起作用了？哪里断了？明天最小调整是什么？
- 长期主义原则：
  - 短期反馈只用于校准路径和动作，不用于定义 Jane 的自我价值。
  - 不把一天的波动过早解释成永久结论；区分"今天的信号"、"需要周/月观察的趋势"、"正在缓慢累积的长期资产"。
  - 长期资产包括：认知资产（阅读、思考、判断力、知识沉淀）、关系资产（稳定支持、边界、可持续互动）、身体资产（睡眠、运动、恢复、能量基础设施）、人格资产（能否承受延迟反馈、波动和中间态）。
  - 过程导向不是自我安慰；复盘应优先看可管理的过程变量，例如最小行动、默认节奏、环境摩擦、恢复状态，而不是高频消耗结果。
- 最差日计划原则：
  - 计划默认按"最差的真实一天"设计，而不是按精力最好、时间最多的一天设计。
  - minimum version 是基线计划，不是失败后的补救。standard / stretch version 只是状态好时的加量。
  - 复盘要判断今天是否需要 worst-day baseline：夜班、早班后、疼痛、睡眠不足、情绪耗竭、通勤/课程挤压时，最小版本本来就是正确版本。
  - 如果计划断掉，优先检查计划是否按最佳日设计得过大，而不是把问题写成 Jane 不够自律。
- 对 habit 信息要结构化、保守：明确完成才写完成；没有证据就写未形成完成记录，不要把提醒、计划或意愿当成完成。
- 复盘正文优先使用这些 section：一天主线、Future Self Vote、自我理解、习惯和恢复、值得进入长期观察、明日最小延续。避免过多机械小标题。
- 使用 Be-Do-Have / Identity Ledger 视角：先写今天哪些"正在成为的人"获得了证据，再写对应行动。不要只列 habit 完成/未完成。至少检查四条身份主线：
  1. 健康、有体能、身体自主的人：Sport、健身、有氧操；塑形 / 身体结构维护：骨盆、足弓、美容灯；不要把骨盆或足弓算成 Sport
  2. 德语/英语能力优秀的人：英语发音、英语影子跟读、德语语法、德语影子跟读、德语表达
  3. 护理科学家 / 教授 / 教师 / ANP / 研究者：Praxisanleitung、Wundmanagement、Python、Nursing Digest、Pflegewissenschaft、Literature Reading、Forschung
  4. 持续跳舞、有表达力和生命力的人：成品舞、基本功、有氧操、身体练习
- 对每条身份主线，区分：今天有证据、今天缺席、或数据不足。缺席不是失败；写成"这个身份今天没有获得新证据"，并给出明天/本周的最小行为版本。
- Future Self Vote 判定：
  - 可以来自 Level A：Sport / 英语发音 / 英语影子跟读 / 德语语法 / 德语影子跟读 / 德语表达。
  - 也可以来自长期身份：Nursing Digest、Praxisanleitung、Wundmanagement、Python、舞蹈/身体练习。
  - 只要是明确完成的小行为就算，不要求完整版本。
  - 如果当天只有计划、提醒、意愿，没有完成证据，不算 Future Self Vote。
- 坏日子版本 / minimum version：
  - Sport：5-10 分钟散步、拉伸或低门槛身体活动。
  - 英语发音：5 分钟。
  - 德语：5-10 分钟语法、影子跟读或表达练习。
  - Nursing Digest / 专业学习：读一段摘要或记录一个问题。
  - 疲惫、夜班恢复、疼痛、睡眠不足时，复盘应优先评价 minimum version 是否合理，而不是用完整版本衡量 Jane。
- Meaning over Activity，不写 debug/技术日志噪音，重点帮助理解那一天。

Obsidian Tracker 义务：
- 如果当天能判断 habit 完成情况，请在"## 时间轴数据" JSON 中保留机器可读字段，便于 tracker 自动同步。
- 同时在 JSON 中保留可选的 identity_ledger 字段，便于周/月复盘聚合。示例：
  "identity_ledger": {
    "health_fitness": {"evidence": ["足弓"], "missing": ["正式训练"], "next_minimum": "5 分钟身体连续性"},
    "language": {"evidence": ["英语发音"], "missing": ["德语语法"], "next_minimum": "10 分钟德语语法或表达"},
    "nursing_science": {"evidence": [], "missing": ["Nursing Digest"], "next_minimum": "读一段摘要"},
    "dance": {"evidence": [], "missing": ["成品舞"], "next_minimum": "跟一小段音乐"}
  },
  "consistency_review": {
    "future_self_vote": {"present": true, "evidence": ["英语发音 5 分钟"], "identity": "language"},
    "worked": ["下班后先做最低版本"],
    "broke": ["夜班后能量不足"],
    "tomorrow_minimum_adjustment": "先完成一个 5 分钟 Future Self Vote",
    "long_termism": {
      "short_term_signal": "今天的反馈只说明恢复成本偏高，不定义能力",
      "asset_vote": "语言资产获得一个小证据",
      "process_variable": "把英语发音放到更早、更低摩擦的时间窗",
      "worst_day_baseline": "明天先按最差日计划保留一个 5 分钟版本，状态好再加量"
    }
  }
- Tracker habit 名称只使用这些：
  Sport、冥想、英语发音、英语影子跟读、德语语法、德语影子跟读、德语表达、骨盆、足弓、健身、基本功、成品舞、有氧操、美容灯、看书、Praxisanleitung、Wundmanagement、Python、Nursing Digest。读书/看书（读一本书、读了某书第N章）记为「看书」。
- Englisch 在 tracker 中默认指"英语发音"；只有用户明确说英语影子跟读 / 英语跟读 / English shadowing 时，才记为"英语影子跟读"。
- Deutsch 在 tracker 中拆成"德语语法"、"德语影子跟读"和"德语表达"；如果当天只知道笼统 Deutsch，不要编造成三个都完成。
- Energy、Mood、Shift Fatigue、Screen Time 是状态/指标，不是 habit。可以保留为 daily state 字段，但不要放进 tracker habit 列表。
- JSON 只放紧凑结构化数据；人类复盘不要解释同步过程。

全部完成后返回 {"action":"silent"}。只有在遇到无法自行解决的问题时才用 send_message 简短说明。`;
}

module.exports = { buildDailyReviewPrompt, DEFAULT_OBSIDIAN_DAILY_FOLDER };
