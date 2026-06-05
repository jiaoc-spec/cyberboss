const CODEX_INTENT_PATTERNS = [
  /(提醒|remind|闹钟|alarm|定时|到点)/i,
  /(日历|calendar|预约|appointment|课程|考试|deadline|截止|班表|上班|出门前|睡觉前|补觉前)/i,
  /(夜班|早班|晚班|nachtdienst|frühdienst|spätdienst).*(日历|calendar|班表|提醒|闹钟|几点|时间|开始|结束|出门|睡觉|补觉|安排|计划)/i,
  /(obsidian|daily note|日记|日志|周记|月记|复盘|weekly review|monthly review)/i,
  /(timeline|时间线|报表|截图|screenshot|统计|趋势|分析|analy[sz]e|insight|correlation)/i,
  /(文件|附件|图片|照片|health|健康数据|apple health|shortcut|快捷指令)/i,
  /(读取|写入|保存|同步|导出|生成.*图|发送.*文件|打开.*文件)/i,
  /(代码|编程|debug|bug|修复|安装|配置|启动|重启|terminal|命令|api|github|git|npm|python|javascript|node)/i,
  /(搜索|查一下|查找|research|论文|文献|资料|最新|验证)/i,
  /(目标[:：]|goal[:：]|最重要|必须.*完成|优先级|延期|取消|放弃)/i,
  /(今天还有什么|还剩什么|哪些.*完成|哪些.*没|我该做什么|接下来做什么)/i,
];

const SOFT_TECH_CHAT_PATTERNS = [
  /(codex|deepseek|telegram|macbook|笔记本|联网|连接|网络|回复|不回复|发消息|没反应)/i,
];

const HARD_TECH_ACTION_PATTERNS = [
  /(检查|查看|排查|修复|重启|启动|配置|安装|更新|提交|push|commit|日志|log|terminal|命令|api|github|git|npm|python|javascript|node)/i,
];

const DAILY_SIGNAL_PATTERNS = [
  /(下班了|到家了|出发了|吃饭了|洗澡了|睡了|醒了|累|开心|难过|烦|不开心|感恩|心情|感觉)/i,
  /(饿|困|冷|热|疼|不舒服|胃口|想吃|身体|夜班.*(感觉|容易|更))/i,
  /(完成了|做完了|学完了|练完了|运动结束|学习结束|英语|德语|sport|english|deutsch)/i,
  /(你好|在吗|早上好|晚安|谢谢|哈哈|嗯|好的|ok|聊聊)/i,
];

class ModelRouterService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.nextModeBySender = new Map();
  }

  setNextMode(senderId, mode) {
    const sender = normalizeText(senderId);
    const normalizedMode = normalizeMode(mode);
    if (!sender || !normalizedMode) {
      return false;
    }
    this.nextModeBySender.set(sender, normalizedMode);
    return true;
  }

  consumeNextMode(senderId) {
    const sender = normalizeText(senderId);
    if (!sender) {
      return "";
    }
    const mode = this.nextModeBySender.get(sender) || "";
    this.nextModeBySender.delete(sender);
    return mode;
  }

  decide({ text = "", senderId = "", provider = "", attachments = [], attachmentFailures = [] } = {}) {
    const body = normalizeText(text);
    const forcedMode = this.consumeNextMode(senderId);
    if (forcedMode) {
      return { mode: forcedMode, reason: "manual_override" };
    }
    if (!this.config.deepseekDailyRoutingEnabled || provider === "system") {
      return { mode: "codex", reason: "daily_routing_disabled_or_system" };
    }
    if (!body || attachments.length || attachmentFailures.length) {
      return { mode: "codex", reason: "attachments_or_empty" };
    }
    if (body.length > (Number(this.config.deepseekDailyMaxChars) || 800)) {
      return { mode: "codex", reason: "long_message" };
    }
    const isSoftTechChat = SOFT_TECH_CHAT_PATTERNS.some((pattern) => pattern.test(body));
    const isHardTechAction = HARD_TECH_ACTION_PATTERNS.some((pattern) => pattern.test(body));
    if (isSoftTechChat) {
      return isHardTechAction
        ? { mode: "codex", reason: "hard_tech_action" }
        : { mode: "deepseek", reason: "soft_tech_chat" };
    }
    if (CODEX_INTENT_PATTERNS.some((pattern) => pattern.test(body))) {
      return { mode: "codex", reason: "tool_or_complex_intent" };
    }
    if (DAILY_SIGNAL_PATTERNS.some((pattern) => pattern.test(body))) {
      return { mode: "deepseek", reason: "daily_signal" };
    }
    return { mode: "deepseek", reason: "default_simple_text" };
  }
}

function normalizeMode(value) {
  const mode = normalizeText(value).toLowerCase();
  return mode === "codex" || mode === "deepseek" ? mode : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ModelRouterService,
  CODEX_INTENT_PATTERNS,
  SOFT_TECH_CHAT_PATTERNS,
  HARD_TECH_ACTION_PATTERNS,
  DAILY_SIGNAL_PATTERNS,
};
