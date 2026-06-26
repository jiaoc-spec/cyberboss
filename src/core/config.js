const os = require("os");
const path = require("path");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");

  return {
    mode,
    argv,
    stateDir,
    workspaceId: readTextEnv("CYBERBOSS_WORKSPACE_ID") || "default",
    workspaceRoot: readTextEnv("CYBERBOSS_WORKSPACE_ROOT") || process.cwd(),
    userName: readTextEnv("CYBERBOSS_USER_NAME") || "User",
    userGender: readTextEnv("CYBERBOSS_USER_GENDER") || "female",
    timeZone: readTextEnv("CYBERBOSS_TIME_ZONE") || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    askWhenUncertain: readOptionalBoolEnv("CYBERBOSS_ASK_WHEN_UNCERTAIN") !== false,
    allowedUserIds: readListEnv("CYBERBOSS_ALLOWED_USER_IDS"),
    channel: readTextEnv("CYBERBOSS_CHANNEL") || "weixin",
    runtime: readTextEnv("CYBERBOSS_RUNTIME") || "codex",
    timelineCommand: readTextEnv("CYBERBOSS_TIMELINE_COMMAND") || "timeline-for-agent",
    accountId: readTextEnv("CYBERBOSS_ACCOUNT_ID"),
    weixinBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readIntEnv("CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS"),
    weixinQrBotType: readTextEnv("CYBERBOSS_WEIXIN_QR_BOT_TYPE") || "3",
    telegramBotToken: readTextEnv("TELEGRAM_BOT_TOKEN") || readTextEnv("CYBERBOSS_TELEGRAM_BOT_TOKEN"),
    telegramAllowedChatIds: readListEnv("TELEGRAM_ALLOWED_CHAT_IDS").concat(readListEnv("CYBERBOSS_TELEGRAM_ALLOWED_CHAT_IDS")),
    telegramApiBaseUrl: readTextEnv("TELEGRAM_API_BASE_URL") || readTextEnv("CYBERBOSS_TELEGRAM_API_BASE_URL") || "https://api.telegram.org",
    telegramFileBaseUrl: readTextEnv("TELEGRAM_FILE_BASE_URL") || readTextEnv("CYBERBOSS_TELEGRAM_FILE_BASE_URL") || "https://api.telegram.org",
    telegramSyncFile: path.join(stateDir, "telegram-sync.json"),
    telegramApiTimeoutMs: readIntEnv("TELEGRAM_API_TIMEOUT_MS") || readIntEnv("CYBERBOSS_TELEGRAM_API_TIMEOUT_MS") || 45_000,
    telegramLongPollGraceMs: readIntEnv("TELEGRAM_LONG_POLL_GRACE_MS") || readIntEnv("CYBERBOSS_TELEGRAM_LONG_POLL_GRACE_MS") || 10_000,
    telegramFileUploadTimeoutMs: readIntEnv("TELEGRAM_FILE_UPLOAD_TIMEOUT_MS") || readIntEnv("CYBERBOSS_TELEGRAM_FILE_UPLOAD_TIMEOUT_MS") || 120_000,
    telegramMinChunkChars: readIntEnv("TELEGRAM_MIN_CHUNK_CHARS") || readIntEnv("CYBERBOSS_TELEGRAM_MIN_CHUNK_CHARS") || 20,
    accountsDir: path.join(stateDir, "accounts"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    checkinConfigFile: path.join(stateDir, "checkin-config.json"),
    criticalHabitsEnabled: readOptionalBoolEnv("CYBERBOSS_CRITICAL_HABITS_ENABLED") !== false,
    criticalHabitsStateFile: readTextEnv("CYBERBOSS_CRITICAL_HABITS_STATE_FILE") || path.join(stateDir, "critical-habits-state.json"),
    criticalHabitsCheckIntervalMs: readIntEnv("CYBERBOSS_CRITICAL_HABITS_CHECK_INTERVAL_MS") || 300_000,
    criticalHabitsLevelAHour: readIntEnv("CYBERBOSS_CRITICAL_HABITS_LEVEL_A_HOUR") ?? 20,
    criticalHabitsLevelAMiddayHour: readIntEnv("CYBERBOSS_CRITICAL_HABITS_LEVEL_A_MIDDAY_HOUR") ?? 12,
    criticalHabitsLevelAMiddayMinute: readIntEnv("CYBERBOSS_CRITICAL_HABITS_LEVEL_A_MIDDAY_MINUTE") ?? 30,
    criticalHabitsWakeGraceMinutes: readIntEnv("CYBERBOSS_CRITICAL_HABITS_WAKE_GRACE_MINUTES") ?? 120,
    criticalHabitsNightShiftLeadMinutes: readIntEnv("CYBERBOSS_CRITICAL_HABITS_NIGHT_SHIFT_LEAD_MINUTES") ?? 180,
    criticalHabitsRecoveryHour: readIntEnv("CYBERBOSS_CRITICAL_HABITS_RECOVERY_HOUR") ?? 15,
    criticalHabitsLevelBHour: readIntEnv("CYBERBOSS_CRITICAL_HABITS_LEVEL_B_HOUR") ?? 18,
    criticalHabitsLevelBWeekdays: readIntegerListEnv("CYBERBOSS_CRITICAL_HABITS_LEVEL_B_WEEKDAYS", [2, 4, 7]),
    criticalHabitsLevelA: readHabitListEnv("CYBERBOSS_CRITICAL_HABITS_LEVEL_A"),
    criticalHabitsLevelB: readHabitListEnv("CYBERBOSS_CRITICAL_HABITS_LEVEL_B"),
    criticalHabitsLevelC: readHabitListEnv("CYBERBOSS_CRITICAL_HABITS_LEVEL_C"),
    failureWatchdogEnabled: readOptionalBoolEnv("CYBERBOSS_FAILURE_WATCHDOG_ENABLED") !== false,
    failureWatchdogStateFile: readTextEnv("CYBERBOSS_FAILURE_WATCHDOG_STATE_FILE") || path.join(stateDir, "failure-watchdog-state.json"),
    failureWatchdogHour: readIntEnv("CYBERBOSS_FAILURE_WATCHDOG_HOUR") ?? 2,
    failureWatchdogCheckIntervalMs: readIntEnv("CYBERBOSS_FAILURE_WATCHDOG_CHECK_INTERVAL_MS") || 900_000,
    failureWatchdogRecheckDays: readIntEnv("CYBERBOSS_FAILURE_WATCHDOG_RECHECK_DAYS") ?? 7,
    dayStrategyEnabled: readOptionalBoolEnv("CYBERBOSS_DAY_STRATEGY_ENABLED") !== false,
    dayStrategyStateFile: readTextEnv("CYBERBOSS_DAY_STRATEGY_STATE_FILE") || path.join(stateDir, "day-strategy-state.json"),
    dayStrategyCheckIntervalMs: readIntEnv("CYBERBOSS_DAY_STRATEGY_CHECK_INTERVAL_MS") || 300_000,
    dayStrategyWakeGraceMinutes: readIntEnv("CYBERBOSS_DAY_STRATEGY_WAKE_GRACE_MINUTES") ?? 120,
    dayStrategyOffDayFirstHour: readIntEnv("CYBERBOSS_DAY_STRATEGY_OFF_DAY_FIRST_HOUR") ?? 11,
    dayStrategyOffDayFirstMinute: readIntEnv("CYBERBOSS_DAY_STRATEGY_OFF_DAY_FIRST_MINUTE") ?? 0,
    dayStrategyLateShiftHour: readIntEnv("CYBERBOSS_DAY_STRATEGY_LATE_SHIFT_HOUR") ?? 10,
    dayStrategyLateShiftMinute: readIntEnv("CYBERBOSS_DAY_STRATEGY_LATE_SHIFT_MINUTE") ?? 30,
    dayStrategyEarlyShiftHour: readIntEnv("CYBERBOSS_DAY_STRATEGY_EARLY_SHIFT_HOUR") ?? 16,
    dayStrategyEarlyShiftMinute: readIntEnv("CYBERBOSS_DAY_STRATEGY_EARLY_SHIFT_MINUTE") ?? 30,
    dayStrategyBeforeEarlyShiftHour: readIntEnv("CYBERBOSS_DAY_STRATEGY_BEFORE_EARLY_SHIFT_HOUR") ?? 17,
    dayStrategyBeforeEarlyShiftMinute: readIntEnv("CYBERBOSS_DAY_STRATEGY_BEFORE_EARLY_SHIFT_MINUTE") ?? 30,
    dayStrategyCourseDayAfterHour: readIntEnv("CYBERBOSS_DAY_STRATEGY_COURSE_DAY_AFTER_HOUR") ?? 16,
    dayStrategyCourseDayAfterMinute: readIntEnv("CYBERBOSS_DAY_STRATEGY_COURSE_DAY_AFTER_MINUTE") ?? 0,
    dayStrategyCourseDayGraceMinutes: readIntEnv("CYBERBOSS_DAY_STRATEGY_COURSE_DAY_GRACE_MINUTES") ?? 30,
    dayOperationsPlannerEnabled: readOptionalBoolEnv("CYBERBOSS_DAY_OPERATIONS_PLANNER_ENABLED") !== false,
    dayOperationsPlanStateFile: readTextEnv("CYBERBOSS_DAY_OPERATIONS_PLAN_STATE_FILE") || path.join(stateDir, "day-operations-plan.json"),
    dayOperationsCourseRecoveryMinutes: readIntEnv("CYBERBOSS_DAY_OPERATIONS_COURSE_RECOVERY_MINUTES") ?? 30,
    dayOperationsShiftRecoveryMinutes: readIntEnv("CYBERBOSS_DAY_OPERATIONS_SHIFT_RECOVERY_MINUTES") ?? 60,
    dayOperationsPriorityWindowEndHour: readIntEnv("CYBERBOSS_DAY_OPERATIONS_PRIORITY_WINDOW_END_HOUR") ?? 21,
    proactiveInterventionEnabled: readOptionalBoolEnv("CYBERBOSS_PROACTIVE_INTERVENTION_ENABLED") !== false,
    proactiveInterventionStateFile: readTextEnv("CYBERBOSS_PROACTIVE_INTERVENTION_STATE_FILE") || path.join(stateDir, "proactive-intervention-state.json"),
    proactiveInterventionDailyMax: readIntEnv("CYBERBOSS_PROACTIVE_INTERVENTION_DAILY_MAX") || 3,
    proactiveInterventionMinGapMinutes: readIntEnv("CYBERBOSS_PROACTIVE_INTERVENTION_MIN_GAP_MINUTES") ?? 90,
    proactiveInterventionHardBoundaryGapMinutes: readIntEnv("CYBERBOSS_PROACTIVE_INTERVENTION_HARD_BOUNDARY_GAP_MINUTES") ?? 20,
    proactiveInterventionCategoryLimits: {
      guardian: readIntEnv("CYBERBOSS_PROACTIVE_GUARDIAN_DAILY_MAX") || 2,
      reflection: readIntEnv("CYBERBOSS_PROACTIVE_REFLECTION_DAILY_MAX") || 1,
      knowledge: readIntEnv("CYBERBOSS_PROACTIVE_KNOWLEDGE_DAILY_MAX") || 1,
      companionship: readIntEnv("CYBERBOSS_PROACTIVE_COMPANIONSHIP_DAILY_MAX") || 1,
    },
    dailyReviewPipelineEnabled: readOptionalBoolEnv("CYBERBOSS_DAILY_REVIEW_PIPELINE_ENABLED") !== false,
    dailyReviewPipelineStateFile: readTextEnv("CYBERBOSS_DAILY_REVIEW_PIPELINE_STATE_FILE") || path.join(stateDir, "daily-review-pipeline-state.json"),
    dailyReviewPipelineHour: readIntEnv("CYBERBOSS_DAILY_REVIEW_PIPELINE_HOUR") ?? 0,
    dailyReviewPipelineMinute: readIntEnv("CYBERBOSS_DAILY_REVIEW_PIPELINE_MINUTE") ?? 15,
    dailyReviewPipelineMaxAttempts: readIntEnv("CYBERBOSS_DAILY_REVIEW_PIPELINE_MAX_ATTEMPTS") || 3,
    dailyReviewPipelineRetryDelayMs: readIntEnv("CYBERBOSS_DAILY_REVIEW_PIPELINE_RETRY_DELAY_MS") || 45 * 60_000,
    dailyReviewPipelineCheckIntervalMs: readIntEnv("CYBERBOSS_DAILY_REVIEW_PIPELINE_CHECK_INTERVAL_MS") || 300_000,
    sleepRecoveryUpdateEnabled: readOptionalBoolEnv("CYBERBOSS_SLEEP_RECOVERY_UPDATE_ENABLED") !== false,
    sleepRecoveryUpdateStateFile: readTextEnv("CYBERBOSS_SLEEP_RECOVERY_UPDATE_STATE_FILE") || path.join(stateDir, "sleep-recovery-update-state.json"),
    sleepRecoveryUpdateCheckIntervalMs: readIntEnv("CYBERBOSS_SLEEP_RECOVERY_UPDATE_CHECK_INTERVAL_MS") || 1_800_000,
    sleepRecoveryUpdateHour: readIntEnv("CYBERBOSS_SLEEP_RECOVERY_UPDATE_HOUR") ?? 9,
    sleepRecoveryUpdateMinute: readIntEnv("CYBERBOSS_SLEEP_RECOVERY_UPDATE_MINUTE") ?? 30,
    sleepRecoveryUpdateLookbackDays: readIntEnv("CYBERBOSS_SLEEP_RECOVERY_UPDATE_LOOKBACK_DAYS") || 2,
    obsidianTrackerEnabled: readOptionalBoolEnv("CYBERBOSS_OBSIDIAN_TRACKER_ENABLED") !== false,
    obsidianTrackerPluginId: readTextEnv("CYBERBOSS_OBSIDIAN_TRACKER_PLUGIN_ID") || "tracker",
    obsidianTrackerSyncDays: readIntEnv("CYBERBOSS_OBSIDIAN_TRACKER_SYNC_DAYS") || 90,
    obsidianTrackerDataFile: readTextEnv("CYBERBOSS_OBSIDIAN_TRACKER_DATA_FILE") || "",
    decisionReviewEnabled: readOptionalBoolEnv("CYBERBOSS_DECISION_REVIEW_ENABLED") !== false,
    decisionReviewDefaultDays: readIntEnv("CYBERBOSS_DECISION_REVIEW_DEFAULT_DAYS") || 14,
    decisionReviewCheckIntervalMs: readIntEnv("CYBERBOSS_DECISION_REVIEW_CHECK_INTERVAL_MS") || 3_600_000,
    decisionReviewHour: readIntEnv("CYBERBOSS_DECISION_REVIEW_HOUR") ?? 11,
    currentStateFile: readTextEnv("CYBERBOSS_CURRENT_STATE_FILE") || path.join(stateDir, "current-state.json"),
    playbookFile: readTextEnv("CYBERBOSS_PLAYBOOK_FILE") || path.join(stateDir, "playbook.json"),
    stateBackupEnabled: readOptionalBoolEnv("CYBERBOSS_STATE_BACKUP_ENABLED") !== false,
    stateBackupHour: readIntEnv("CYBERBOSS_STATE_BACKUP_HOUR") ?? 1,
    knowledgeResurfaceEnabled: readOptionalBoolEnv("CYBERBOSS_KNOWLEDGE_RESURFACE_ENABLED") !== false,
    knowledgeResurfaceHour: readIntEnv("CYBERBOSS_KNOWLEDGE_RESURFACE_HOUR") ?? 17,
    knowledgeResurfaceStateFile: readTextEnv("CYBERBOSS_KNOWLEDGE_RESURFACE_STATE_FILE") || path.join(stateDir, "knowledge-resurface-state.json"),
    knowledgeRecallExtraFolders: readListEnv("CYBERBOSS_KNOWLEDGE_RECALL_EXTRA_FOLDERS").length
      ? readListEnv("CYBERBOSS_KNOWLEDGE_RECALL_EXTRA_FOLDERS")
      : ["06. Pflegeausbildung", "Wundmanagement"],
    knowledgeRecallRotationDays: readIntEnv("CYBERBOSS_KNOWLEDGE_RECALL_ROTATION_DAYS") || 21,
    insightRecallEnabled: readOptionalBoolEnv("CYBERBOSS_INSIGHT_RECALL_ENABLED") !== false,
    insightRecallMaxResults: readIntEnv("CYBERBOSS_INSIGHT_RECALL_MAX_RESULTS") || 3,
    weeklyReviewPipelineEnabled: readOptionalBoolEnv("CYBERBOSS_WEEKLY_REVIEW_PIPELINE_ENABLED") !== false,
    weeklyReviewPipelineWeekday: readIntEnv("CYBERBOSS_WEEKLY_REVIEW_PIPELINE_WEEKDAY") ?? 1,
    weeklyReviewPipelineHour: readIntEnv("CYBERBOSS_WEEKLY_REVIEW_PIPELINE_HOUR") ?? 4,
    monthlyReviewPipelineEnabled: readOptionalBoolEnv("CYBERBOSS_MONTHLY_REVIEW_PIPELINE_ENABLED") !== false,
    monthlyReviewPipelineHour: readIntEnv("CYBERBOSS_MONTHLY_REVIEW_PIPELINE_HOUR") ?? 9,
    periodicReviewPipelineStateFile: readTextEnv("CYBERBOSS_PERIODIC_REVIEW_PIPELINE_STATE_FILE") || path.join(stateDir, "periodic-review-pipeline-state.json"),
    periodicReviewPipelineMaxAttempts: readIntEnv("CYBERBOSS_PERIODIC_REVIEW_PIPELINE_MAX_ATTEMPTS") || 3,
    periodicReviewPipelineRetryDelayMs: readIntEnv("CYBERBOSS_PERIODIC_REVIEW_PIPELINE_RETRY_DELAY_MS") || 60 * 60_000,
    periodicReviewBridgeFallbackEnabled: readOptionalBoolEnv("CYBERBOSS_PERIODIC_REVIEW_BRIDGE_FALLBACK_ENABLED") !== false,
    obsidianWeeklyFolder: readTextEnv("CYBERBOSS_OBSIDIAN_WEEKLY_FOLDER") || "03. 🔵 Tagebuch/02. 周记",
    obsidianMonthlyFolder: readTextEnv("CYBERBOSS_OBSIDIAN_MONTHLY_FOLDER") || "03. 🔵 Tagebuch/03. 月记",
    knowledgeFolder: readTextEnv("CYBERBOSS_KNOWLEDGE_FOLDER") || "01. ⚪ Wissenskarte",
    experienceDashboardPath: readTextEnv("CYBERBOSS_EXPERIENCE_DASHBOARD_PATH") || "01. ⚪ Wissenskarte/00. Experience Compound Dashboard.md",
    knowledgeInboxFolder: readTextEnv("CYBERBOSS_KNOWLEDGE_INBOX_FOLDER") || "01. ⚪ Wissenskarte/00. Knowledge Inbox",
    notizenFolder: readTextEnv("CYBERBOSS_NOTIZEN_FOLDER") || "02. 🟡 Notizen",
    digestionEnabled: readOptionalBoolEnv("CYBERBOSS_DIGESTION_ENABLED") !== false,
    digestionHour: readIntEnv("CYBERBOSS_DIGESTION_HOUR") ?? 21,
    digestionCheckIntervalMs: readIntEnv("CYBERBOSS_DIGESTION_CHECK_INTERVAL_MS") || 1_800_000,
    digestionStateFile: readTextEnv("CYBERBOSS_DIGESTION_STATE_FILE") || path.join(stateDir, "digestion-state.json"),
    digestionBridgeFallbackEnabled: readOptionalBoolEnv("CYBERBOSS_DIGESTION_BRIDGE_FALLBACK_ENABLED") !== false,
    knowledgeRecallAcademicTags: readListEnv("CYBERBOSS_KNOWLEDGE_RECALL_ACADEMIC_TAGS"),
    researchLedgerFile: readTextEnv("CYBERBOSS_RESEARCH_LEDGER_FILE") || path.join(stateDir, "research-ledger.json"),
    campaignsFile: readTextEnv("CYBERBOSS_CAMPAIGNS_FILE") || path.join(stateDir, "campaigns.json"),
    campaignBoostDaysBefore: readIntEnv("CYBERBOSS_CAMPAIGN_BOOST_DAYS_BEFORE") || 14,
    shiftRatingEnabled: readOptionalBoolEnv("CYBERBOSS_SHIFT_RATING_ENABLED") !== false,
    shiftRatingAutoPromptEnabled: readOptionalBoolEnv("CYBERBOSS_SHIFT_RATING_AUTO_PROMPT_ENABLED") !== false,
    shiftRatingStateFile: readTextEnv("CYBERBOSS_SHIFT_RATING_STATE_FILE") || path.join(stateDir, "shift-rating-state.json"),
    shiftRatingCooldownMs: readIntEnv("CYBERBOSS_SHIFT_RATING_COOLDOWN_MS") || 8 * 60 * 60_000,
    shiftRatingCheckIntervalMs: readIntEnv("CYBERBOSS_SHIFT_RATING_CHECK_INTERVAL_MS") || 300_000,
    shiftRatingAfterShiftDelayMinutes: readIntEnv("CYBERBOSS_SHIFT_RATING_AFTER_SHIFT_DELAY_MINUTES") || 8,
    shiftRatingAfterShiftWindowMinutes: readIntEnv("CYBERBOSS_SHIFT_RATING_AFTER_SHIFT_WINDOW_MINUTES") || 180,
    focusProtectionEnabled: readOptionalBoolEnv("CYBERBOSS_FOCUS_PROTECTION_ENABLED") !== false,
    focusProtectionStateFile: readTextEnv("CYBERBOSS_FOCUS_PROTECTION_STATE_FILE") || path.join(stateDir, "focus-protection-state.json"),
    focusProtectionReminderSnoozeMs: readIntEnv("CYBERBOSS_FOCUS_PROTECTION_REMINDER_SNOOZE_MS") || 5 * 60_000,
    missingContextEnabled: readOptionalBoolEnv("CYBERBOSS_MISSING_CONTEXT_ENABLED") !== false,
    missingContextStateFile: readTextEnv("CYBERBOSS_MISSING_CONTEXT_STATE_FILE") || path.join(stateDir, "missing-context-state.json"),
    missingContextCheckIntervalMs: readIntEnv("CYBERBOSS_MISSING_CONTEXT_CHECK_INTERVAL_MS") || 300_000,
    missingContextDailyMaxQuestions: readIntEnv("CYBERBOSS_MISSING_CONTEXT_DAILY_MAX_QUESTIONS") || 3,
    missingContextFirstPromptHour: readIntEnv("CYBERBOSS_MISSING_CONTEXT_FIRST_PROMPT_HOUR") ?? 20,
    missingContextDefaultHour: readIntEnv("CYBERBOSS_MISSING_CONTEXT_DEFAULT_HOUR") ?? 20,
    missingContextEarlyShiftHour: readIntEnv("CYBERBOSS_MISSING_CONTEXT_EARLY_SHIFT_HOUR") ?? 18,
    missingContextLateShiftHour: readIntEnv("CYBERBOSS_MISSING_CONTEXT_LATE_SHIFT_HOUR") ?? 23,
    missingContextNightShiftHour: readIntEnv("CYBERBOSS_MISSING_CONTEXT_NIGHT_SHIFT_HOUR") ?? 20,
    missingContextOffDayHour: readIntEnv("CYBERBOSS_MISSING_CONTEXT_OFF_DAY_HOUR") ?? 20,
    missingContextResponseWindowMs: readIntEnv("CYBERBOSS_MISSING_CONTEXT_RESPONSE_WINDOW_MS") || 6 * 60 * 60_000,
    patternLedgerFile: readTextEnv("CYBERBOSS_PATTERN_LEDGER_FILE") || path.join(stateDir, "pattern-ledger.json"),
    experienceLedgerFile: readTextEnv("CYBERBOSS_EXPERIENCE_LEDGER_FILE") || path.join(stateDir, "experience-ledger.json"),
    experienceGuideThreshold: readIntEnv("CYBERBOSS_EXPERIENCE_GUIDE_THRESHOLD") || 3,
    winsLedgerFile: readTextEnv("CYBERBOSS_WINS_LEDGER_FILE") || path.join(stateDir, "wins-ledger.json"),
    decisionJournalFile: readTextEnv("CYBERBOSS_DECISION_JOURNAL_FILE") || path.join(stateDir, "decision-journal.json"),
    priorityAwarenessEnabled: readOptionalBoolEnv("CYBERBOSS_PRIORITY_AWARENESS_ENABLED") !== false,
    priorityAwarenessStateFile: readTextEnv("CYBERBOSS_PRIORITY_AWARENESS_STATE_FILE") || path.join(stateDir, "priority-awareness.json"),
    priorityAwarenessCheckIntervalMs: readIntEnv("CYBERBOSS_PRIORITY_AWARENESS_CHECK_INTERVAL_MS") || 300_000,
    priorityAwarenessCooldownMs: readIntEnv("CYBERBOSS_PRIORITY_AWARENESS_COOLDOWN_MS") || 3_600_000,
    priorityAwarenessWakeGraceMinutes: readIntEnv("CYBERBOSS_PRIORITY_AWARENESS_WAKE_GRACE_MINUTES") ?? 120,
    priorityAwarenessCheckpointMinutes: readIntegerListEnv("CYBERBOSS_PRIORITY_AWARENESS_CHECKPOINT_MINUTES", [120, 45]),
    priorityAwarenessBoundaryBufferMinutes: readIntEnv("CYBERBOSS_PRIORITY_AWARENESS_BOUNDARY_BUFFER_MINUTES") ?? 30,
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    usageFile: path.join(stateDir, "usage.json"),
    usageTimeZone: readTextEnv("CYBERBOSS_USAGE_TIME_ZONE") || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    usagePricing: {
      inputUsdPer1M: readFloatEnv("CYBERBOSS_USAGE_INPUT_USD_PER_1M"),
      cachedInputUsdPer1M: readFloatEnv("CYBERBOSS_USAGE_CACHED_INPUT_USD_PER_1M"),
      outputUsdPer1M: readFloatEnv("CYBERBOSS_USAGE_OUTPUT_USD_PER_1M"),
      reasoningUsdPer1M: readFloatEnv("CYBERBOSS_USAGE_REASONING_USD_PER_1M"),
      blendedUsdPer1M: readFloatEnv("CYBERBOSS_USAGE_BLENDED_USD_PER_1M") || 2,
    },
    dailyThreadRollover: readOptionalBoolEnv("CYBERBOSS_DAILY_THREAD_ROLLOVER") === true,
    projectToolContextFile: path.join(stateDir, "project-tool-runtime-context.json"),
    weixinInstructionsFile: path.join(stateDir, "weixin-instructions.md"),
    weixinOperationsFile: path.resolve(__dirname, "..", "..", "templates", "weixin-operations.md"),
    stickersDir: path.join(stateDir, "stickers"),
    stickerAssetsDir: path.join(stateDir, "stickers", "assets"),
    stickersIndexFile: path.join(stateDir, "stickers", "index.json"),
    stickerTagsFile: path.join(stateDir, "stickers", "tags.json"),
    stickersTemplateDir: path.resolve(__dirname, "..", "..", "templates", "stickers"),
    stickersTemplateIndexFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.resolve(__dirname, "..", "..", "scripts", "normalize-sticker-gif.js"),
    diaryBackend: readTextEnv("CYBERBOSS_DIARY_BACKEND") || "local",
    diaryAutoCapture: readBoolEnv("CYBERBOSS_DIARY_AUTO_CAPTURE"),
    diaryAutoCaptureTarget: readTextEnv("CYBERBOSS_DIARY_AUTO_CAPTURE_TARGET") || "diary",
    diaryDir: path.join(stateDir, "diary"),
    dailyInboxDir: readTextEnv("CYBERBOSS_DAILY_INBOX_DIR") || path.join(stateDir, "daily-inbox"),
    dailyInboxArchiveDir: readTextEnv("CYBERBOSS_DAILY_INBOX_ARCHIVE_DIR") || path.join(stateDir, "daily-inbox-archive"),
    diaryTimeZone: readTextEnv("CYBERBOSS_DIARY_TIME_ZONE") || readTextEnv("CYBERBOSS_TIME_ZONE") || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    timelineAutoCapture: readOptionalBoolEnv("CYBERBOSS_TIMELINE_AUTO_CAPTURE") !== false,
    timelineAutoCaptureStateFile: readTextEnv("CYBERBOSS_TIMELINE_AUTO_CAPTURE_STATE_FILE") || path.join(stateDir, "timeline-auto-capture.json"),
    obsidianVaultDir: readTextEnv("OBSIDIAN_VAULT_DIR") || readTextEnv("CYBERBOSS_OBSIDIAN_VAULT_DIR") || "",
    obsidianDailyNoteDir: readTextEnv("CYBERBOSS_OBSIDIAN_DAILY_DIR"),
    obsidianDailyFolder: readTextEnv("OBSIDIAN_DAILY_FOLDER") || readTextEnv("CYBERBOSS_OBSIDIAN_DAILY_FOLDER") || "03. 🔵 Tagebuch/01. 日记",
    obsidianDailySection: readTextEnv("OBSIDIAN_DAILY_SECTION") || readTextEnv("CYBERBOSS_OBSIDIAN_DAILY_SECTION") || "## 今日记录",
    obsidianDailyTemplateFile: readTextEnv("OBSIDIAN_DAILY_TEMPLATE_FILE") || readTextEnv("CYBERBOSS_OBSIDIAN_DAILY_TEMPLATE_FILE") || "",
    calendarProvider: readTextEnv("CYBERBOSS_CALENDAR_PROVIDER") || "apple",
    appleCalendarScriptFile: readTextEnv("CYBERBOSS_APPLE_CALENDAR_SCRIPT_FILE") || path.resolve(__dirname, "..", "..", "scripts", "apple-calendar-read.swift"),
    appleCalendarCacheFile: readTextEnv("CYBERBOSS_APPLE_CALENDAR_CACHE_FILE") || path.join(stateDir, "apple-calendar-cache.json"),
    appleCalendarCacheMaxAgeMs: readIntEnv("CYBERBOSS_APPLE_CALENDAR_CACHE_MAX_AGE_MS") || 900_000,
    appleCalendarPreferCache: readOptionalBoolEnv("CYBERBOSS_APPLE_CALENDAR_PREFER_CACHE") !== false,
    calendarTimelineSync: readOptionalBoolEnv("CYBERBOSS_CALENDAR_TIMELINE_SYNC") !== false,
    calendarTimelineSyncIntervalMs: readIntEnv("CYBERBOSS_CALENDAR_TIMELINE_SYNC_INTERVAL_MS") || 600_000,
    calendarTimelineSyncDays: readIntEnv("CYBERBOSS_CALENDAR_TIMELINE_SYNC_DAYS") || 2,
    calendarTimelineSyncCalendars: readListEnv("CYBERBOSS_CALENDAR_TIMELINE_SYNC_CALENDARS"),
    today3x3TimelineSync: readOptionalBoolEnv("CYBERBOSS_TODAY3X3_TIMELINE_SYNC") !== false,
    today3x3DatabasePath: readTextEnv("CYBERBOSS_TODAY3X3_DATABASE_PATH") || path.join(os.homedir(), "Library/Group Containers/8774ZX9976.3x3.today/Model_3x3.sqlite"),
    today3x3SqliteBin: readTextEnv("CYBERBOSS_TODAY3X3_SQLITE_BIN") || "sqlite3",
    today3x3SqliteTimeoutMs: readIntEnv("CYBERBOSS_TODAY3X3_SQLITE_TIMEOUT_MS") || 10_000,
    today3x3SqliteTimeoutCooldownMs: readIntEnv("CYBERBOSS_TODAY3X3_SQLITE_TIMEOUT_COOLDOWN_MS") || 3_600_000,
    today3x3TimelineSyncIntervalMs: readIntEnv("CYBERBOSS_TODAY3X3_TIMELINE_SYNC_INTERVAL_MS") || 600_000,
    today3x3TimelineSyncDays: readIntEnv("CYBERBOSS_TODAY3X3_TIMELINE_SYNC_DAYS") || 2,
    healthInboxDir: readTextEnv("CYBERBOSS_HEALTH_INBOX_DIR") || path.join(stateDir, "health-inbox"),
    healthImportStateFile: readTextEnv("CYBERBOSS_HEALTH_IMPORT_STATE_FILE") || path.join(stateDir, "health-imports.json"),
    healthSourceLabel: readTextEnv("CYBERBOSS_HEALTH_SOURCE_LABEL") || "Apple Health / Shortcuts",
    healthAutoImport: readOptionalBoolEnv("CYBERBOSS_HEALTH_AUTO_IMPORT") !== false,
    healthImportIntervalMs: readIntEnv("CYBERBOSS_HEALTH_IMPORT_INTERVAL_MS") || 300_000,
    locationStoreFile: path.join(stateDir, "locations.json"),
    locationHost: readTextEnv("CYBERBOSS_LOCATION_HOST") || "0.0.0.0",
    locationPort: readIntEnv("CYBERBOSS_LOCATION_PORT") || 4318,
    locationToken: readTextEnv("CYBERBOSS_LOCATION_TOKEN"),
    locationHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_HISTORY_LIMIT") || 1000,
    locationMovementEventLimit: readIntEnv("CYBERBOSS_LOCATION_MOVEMENT_EVENT_LIMIT"),
    locationBatteryHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_BATTERY_HISTORY_LIMIT"),
    locationKnownPlaces: readKnownPlacesEnv(),
    locationKnownPlaceRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_PLACE_RADIUS_METERS") || 150,
    locationStayMergeRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_MERGE_RADIUS_METERS") || 100,
    locationStayBreakConfirmRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_RADIUS_METERS") || 200,
    locationStayBreakConfirmSamples: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_SAMPLES") || 2,
    locationMajorMoveThresholdMeters: readIntEnv("CYBERBOSS_LOCATION_MAJOR_MOVE_THRESHOLD_METERS") || 1000,
    startWithLocationServer: resolveLocationServerEnabled({
      mode,
      enabled: readOptionalBoolEnv("CYBERBOSS_ENABLE_LOCATION_SERVER"),
    }),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    codexEndpoint: readTextEnv("CYBERBOSS_CODEX_ENDPOINT"),
    codexCommand: readTextEnv("CYBERBOSS_CODEX_COMMAND"),
    codexModel: readTextEnv("CYBERBOSS_CODEX_MODEL"),
    codexModelProvider: readTextEnv("CYBERBOSS_CODEX_MODEL_PROVIDER"),
    codexNativeImageInput: readOptionalBoolEnv("CYBERBOSS_CODEX_NATIVE_IMAGE_INPUT"),
    deepseekFallbackEnabled: readOptionalBoolEnv("CYBERBOSS_DEEPSEEK_FALLBACK_ENABLED") === true,
    deepseekApiKey: readTextEnv("DEEPSEEK_API_KEY") || readTextEnv("CYBERBOSS_DEEPSEEK_API_KEY"),
    deepseekApiBaseUrl: readTextEnv("CYBERBOSS_DEEPSEEK_API_BASE_URL") || "https://api.deepseek.com",
    deepseekModel: readTextEnv("CYBERBOSS_DEEPSEEK_MODEL") || "deepseek-v4-flash",
    deepseekTimeoutMs: readIntEnv("CYBERBOSS_DEEPSEEK_TIMEOUT_MS") || 30_000,
    deepseekMaxOutputTokens: readIntEnv("CYBERBOSS_DEEPSEEK_MAX_OUTPUT_TOKENS") || 1200,
    deepseekFallbackAfterMs: readIntEnv("CYBERBOSS_DEEPSEEK_FALLBACK_AFTER_MS") || 90_000,
    deepseekDailyRoutingEnabled: readOptionalBoolEnv("CYBERBOSS_DEEPSEEK_DAILY_ROUTING_ENABLED") === true,
    deepseekDailyMaxChars: readIntEnv("CYBERBOSS_DEEPSEEK_DAILY_MAX_CHARS") || 800,
    visionMode: readTextEnv("CYBERBOSS_VISION_MODE") || "auto",
    visionProvider: readTextEnv("CYBERBOSS_VISION_PROVIDER") || "openai-compatible",
    visionApiBaseUrl: readTextEnv("CYBERBOSS_VISION_API_BASE_URL"),
    visionApiKey: readTextEnv("CYBERBOSS_VISION_API_KEY"),
    visionModel: readTextEnv("CYBERBOSS_VISION_MODEL"),
    visionTimeoutMs: readIntEnv("CYBERBOSS_VISION_TIMEOUT_MS") || 30_000,
    claudeCommand: readTextEnv("CYBERBOSS_CLAUDE_COMMAND") || "claude",
    claudeModel: readTextEnv("CYBERBOSS_CLAUDE_MODEL") || "",
    claudeContextWindow: readIntEnv("CYBERBOSS_CLAUDE_CONTEXT_WINDOW"),
    claudeMaxOutputTokens: readIntEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    claudePermissionMode: readTextEnv("CYBERBOSS_CLAUDE_PERMISSION_MODE") || "default",
    claudeDisableVerbose: readBoolEnv("CYBERBOSS_CLAUDE_DISABLE_VERBOSE"),
    claudeExtraArgs: readListEnv("CYBERBOSS_CLAUDE_EXTRA_ARGS"),
    sessionsFile: path.join(stateDir, "sessions.json"),
    startWithCheckin: (mode === "start" && hasArgFlag(argv, "--checkin")) || readBoolEnv("CYBERBOSS_ENABLE_CHECKIN"),
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readIntegerListEnv(name, fallback = []) {
  const values = readListEnv(name)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value));
  return values.length ? values : fallback;
}

function readHabitListEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    const defaults = require("../services/critical-habits-monitor");
    if (name.endsWith("LEVEL_A")) return defaults.DEFAULT_LEVEL_A;
    if (name.endsWith("LEVEL_B")) return defaults.DEFAULT_LEVEL_B;
    return defaults.DEFAULT_LEVEL_C;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readOptionalBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return undefined;
}

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readFloatEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readKnownPlacesEnv() {
  const fromJson = parseKnownPlacesJson(readTextEnv("CYBERBOSS_LOCATION_KNOWN_PLACES"));
  const fromCenters = [
    parseKnownPlaceCenter("home", readTextEnv("CYBERBOSS_LOCATION_HOME_CENTER")),
    parseKnownPlaceCenter("work", readTextEnv("CYBERBOSS_LOCATION_WORK_CENTER")),
  ].filter(Boolean);
  return [...fromJson, ...fromCenters];
}

function parseKnownPlacesJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseKnownPlaceCenter(tag, value) {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { tag, latitude, longitude };
}

function hasArgFlag(argv, flag) {
  return Array.isArray(argv) && argv.some((item) => String(item || "").trim() === flag);
}

function resolveLocationServerEnabled({ mode, enabled }) {
  if (mode !== "start") {
    return false;
  }
  if (typeof enabled === "boolean") {
    return enabled;
  }
  return false;
}

module.exports = { readConfig };
