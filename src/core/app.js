const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { createChannelAdapter } = require("../adapters/channel");
const { DEFAULT_MIN_WEIXIN_CHUNK, MAX_MIN_WEIXIN_CHUNK } = require("../adapters/channel/weixin/config-store");
const { persistIncomingWeixinAttachments } = require("../adapters/channel/weixin/media-receive");
const { createCodexRuntimeAdapter } = require("../adapters/runtime/codex");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const { findModelByQuery } = require("../adapters/runtime/codex/model-catalog");
const { createTimelineIntegration } = require("../integrations/timeline");
const {
  assembleRuntimeTurnText,
  buildInboundDraft,
  buildMergedInboundPrepared,
  clonePreparedInboundMessage,
  isPlainTextPreparedMessage,
  shouldBatchImageOnlyInbound,
  takeImageOnlyBatchMessages,
} = require("./inbound-turn");
const { resolveVisionContext } = require("../services/vision-context");
const {
  buildWeixinHelpText,
} = require("./command-registry");
const { CheckinConfigStore, parseCheckinRangeMinutes, resolveDefaultCheckinRange } = require("./checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("./default-targets");
const { StreamDelivery } = require("./stream-delivery");
const { ThreadStateStore } = require("./thread-state-store");
const { UsageStore } = require("./usage-store");
const { DeferredSystemReplyStore } = require("./deferred-system-reply-store");
const { SystemMessageQueueStore } = require("./system-message-queue-store");
const { SystemMessageDispatcher } = require("./system-message-dispatcher");
const { TimelineScreenshotQueueStore } = require("./timeline-screenshot-queue-store");
const { TurnGateStore } = require("./turn-gate-store");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const { CriticalHabitsMonitor } = require("../services/critical-habits-monitor");
const { DeepSeekFallbackService } = require("../services/deepseek-fallback-service");
const { DailyReviewPipelineService } = require("../services/daily-review-pipeline-service");
const { buildPlaybookTrigger, ANCHOR_LABELS: PLAYBOOK_ANCHOR_LABELS } = require("../services/playbook-service");
const { PeriodicReviewPipelineService } = require("../services/periodic-review-pipeline-service");
const { StateBackupService } = require("../services/state-backup-service");
const { KnowledgeResurfaceService } = require("../services/knowledge-resurface-service");
const { DecisionReviewMonitor } = require("../services/decision-review-monitor");
const { FailureWatchdogService } = require("../services/failure-watchdog-service");
const { FOCUS_REMINDER_PREFIX } = require("../services/focus-protection-service");
const { ModelRouterService } = require("../services/model-router-service");
const { isWakeUpMessage } = require("../services/timeline-auto-capture-service");
const {
  matchesCommandPrefix,
  canonicalizeCommandTokens,
  extractApprovalFilePaths,
  isPathWithinRoot,
  normalizeCommandTokens,
  splitCommandLine,
} = require("../adapters/runtime/shared/approval-command");
const { runSystemCheckinPoller } = require("../app/system-checkin-poller");
const { createProjectTooling } = require("../tools/create-project-tooling");
const { detectDecisionTrigger, buildDecisionTriggerAnnotation } = require("./decision-trigger");
const { DecisionJournalState, isDecisionJournalConfirmation } = require("./decision-journal-state");
const { detectWinTrigger, buildWinsPrompt, parseWinsResponse } = require("./wins-trigger");
const { WinsLedgerState } = require("./wins-ledger-state");
const { detectPatternViewTrigger, formatPatternList } = require("./pattern-trigger");
const { matchPatternsByDomain } = require("./pattern-domain-map");
const { UnmatchedEvidenceStore } = require("./unmatched-evidence-store");
const { checkReviewStatus, formatStatusReport } = require("../services/daily-review-check");
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_INBOUND_STICKER_IMAGE_BATCH = 10;
const INBOUND_IMAGE_BATCH_IDLE_MS = 1_500;

function createRuntimeAdapter(config) {
  if (config.runtime === "claudecode") {
    return createClaudeCodeRuntimeAdapter(config);
  }
  return createCodexRuntimeAdapter(config);
}

class CyberbossApp {
  constructor(config) {
    this.config = config;
    this.channelAdapter = createChannelAdapter(config);
    this.timelineIntegration = createTimelineIntegration(config);
    const projectTooling = createProjectTooling(config, {
      channelAdapter: this.channelAdapter,
      timelineIntegration: this.timelineIntegration,
    });
    this.projectServices = projectTooling.services;
    this.projectToolHost = projectTooling.toolHost;
    this.runtimeContextStore = projectTooling.runtimeContextStore;
    this.runtimeAdapter = createRuntimeAdapter(config);
    this.threadStateStore = new ThreadStateStore();
    this.usageStore = new UsageStore({
      filePath: config.usageFile,
      timeZone: config.usageTimeZone,
      pricing: config.usagePricing,
    });
    this.systemMessageQueue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    if (this.projectServices?.priorityAwareness) {
      this.projectServices.priorityAwareness.systemMessageQueue = this.systemMessageQueue;
      this.projectServices.priorityAwareness.sessionStore = this.runtimeAdapter.getSessionStore();
    }
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
    this.timelineScreenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.criticalHabitsMonitor = new CriticalHabitsMonitor({
      config,
      timeline: this.projectServices.timeline,
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      systemMessageQueue: this.systemMessageQueue,
      dailyState: this.projectServices.dailyState,
      focusProtection: this.projectServices.focusProtection,
      patternLedger: this.projectServices.patternLedger,
      currentState: this.projectServices.currentState,
      campaign: this.projectServices.campaign,
    });
    this.dailyReviewPipeline = new DailyReviewPipelineService({
      config,
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      systemMessageQueue: this.systemMessageQueue,
      dailyInbox: this.projectServices.dailyInbox,
    });
    this.failureWatchdog = new FailureWatchdogService({
      config,
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      dailyInbox: this.projectServices.dailyInbox,
      reviewPipeline: this.dailyReviewPipeline,
    });
    this.periodicReviewPipeline = new PeriodicReviewPipelineService({
      config,
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      systemMessageQueue: this.systemMessageQueue,
    });
    this.stateBackup = new StateBackupService({ config });
    this.knowledgeResurface = new KnowledgeResurfaceService({
      config,
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      systemMessageQueue: this.systemMessageQueue,
      currentState: this.projectServices.currentState,
    });
    this.decisionReviewMonitor = new DecisionReviewMonitor({
      config,
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      systemMessageQueue: this.systemMessageQueue,
      decisionJournal: this.projectServices.decisionJournal,
    });
    this.turnGateStore = new TurnGateStore();
    this.deepseekFallback = new DeepSeekFallbackService({ config });
    this.modelRouter = new ModelRouterService({ config });
    this.deepseekConversationBySender = new Map();
    this.fallbackContextByRunKey = new Map();
    this.pendingInboundByScope = new Map();
    this.pendingImageInboundByScope = new Map();
    this.turnBoundaryScopeKeys = new Set();
    this.systemMessageDispatcher = null;
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      runtimeId: this.runtimeAdapter.describe().id,
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
      onEmptyReply: (payload) => this.handleEmptyModelReply(payload),
    });
    this.pendingOperationByRunKey = new Map();
    this.decisionJournalState = new DecisionJournalState();
    this.winsLedgerState = new WinsLedgerState();
    this.unmatchedEvidenceStore = new UnmatchedEvidenceStore({
      filePath: path.join(config.stateDir, "unmatched-evidence.json"),
    });
    this.runtimeEventChain = Promise.resolve();
    this.runtimeAdapter.onEvent((event) => {
      this.threadStateStore.applyRuntimeEvent(event);
      this.runtimeEventChain = this.runtimeEventChain
        .catch(() => {})
        .then(() => this.handleRuntimeEvent(event))
        .catch((error) => {
          const message = error instanceof Error ? error.stack || error.message : String(error);
          console.error(`[cyberboss] runtime event handling failed type=${event?.type || "(unknown)"} ${message}`);
        });
    });
  }

  printDoctor() {
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channel: this.channelAdapter.describe(),
      runtime: this.runtimeAdapter.describe(),
      timeline: this.timelineIntegration.describe(),
      threads: this.threadStateStore.snapshot(),
    }, null, 2));
  }

  async login() {
    await this.channelAdapter.login();
  }

  printAccounts() {
    this.channelAdapter.printAccounts();
  }

  async start() {
    const account = this.channelAdapter.resolveAccount();
    this.activeAccountId = account.accountId;
    this.systemMessageDispatcher = new SystemMessageDispatcher({
      queueStore: this.systemMessageQueue,
      config: this.config,
      accountId: account.accountId,
    });
    const runtimeState = await this.runtimeAdapter.initialize();
    const knownContextTokens = Object.keys(this.channelAdapter.getKnownContextTokens()).length;
    const syncBuffer = this.channelAdapter.loadSyncBuffer();
    await this.restoreBoundThreadSubscriptions();

    console.log("[cyberboss] bootstrap ok");
    console.log(`[cyberboss] channel=${this.channelAdapter.describe().id}`);
    console.log(`[cyberboss] runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[cyberboss] timeline=${this.timelineIntegration.describe().id}`);
    console.log(`[cyberboss] account=${account.accountId}`);
    console.log(`[cyberboss] baseUrl=${account.baseUrl}`);
    console.log(`[cyberboss] workspaceRoot=${this.config.workspaceRoot}`);
    console.log(`[cyberboss] knownContextTokens=${knownContextTokens}`);
    console.log(`[cyberboss] syncBuffer=${syncBuffer ? "ready" : "empty"}`);
    console.log(`[cyberboss] runtimeEndpoint=${runtimeState.endpoint || runtimeState.command || "(spawn)"}`);
    console.log(`[cyberboss] runtimeModels=${runtimeState.models?.length || 0}`);
    console.log(
      `[cyberboss] deepseekFallback=${this.deepseekFallback.isEnabled() ? "enabled" : "disabled"} model=${this.config.deepseekModel || ""}`
    );
    console.log(
      `[cyberboss] deepseekDailyRouting=${this.config.deepseekDailyRoutingEnabled ? "enabled" : "disabled"} maxChars=${this.config.deepseekDailyMaxChars || 0}`
    );
    if (this.config.startWithLocationServer) {
      await this.ensureLocationServerStarted();
    }
    console.log(`[cyberboss] bridge loop started; waiting for ${this.channelAdapter.describe().id} messages.`);
    if (this.config.startWithCheckin) {
      console.log("[cyberboss] checkin: enabled");
      void runSystemCheckinPoller(this.config).catch((error) => {
        console.error(`[cyberboss] checkin poller stopped: ${error.message}`);
      });
    }

    const shutdown = createShutdownController(async () => {
      this.clearPendingImageInboundTimers();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    });

    try {
      let consecutiveFailures = 0;
      while (!shutdown.stopped) {
        try {
          await Promise.all([
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
            this.flushPendingCalendarTimelineSync(),
            this.flushPendingHealthImports(),
            this.flushCriticalHabitsMonitor(account),
            this.flushPriorityAwarenessMonitor(account),
            this.flushMissingContextMonitor(account),
            this.flushDailyReviewPipeline(account),
            this.flushPeriodicReviewPipeline(account),
            this.flushStateBackup(),
            this.flushKnowledgeResurface(account),
            this.flushDecisionReviewMonitor(account),
            this.flushFailureWatchdog(account),
          ]);
          const response = await this.channelAdapter.getUpdates({
            syncBuffer: this.channelAdapter.loadSyncBuffer(),
            timeoutMs: this.resolveLongPollTimeoutMs(),
          });
          assertChannelUpdateResponse(response, this.channelAdapter.describe().id);
          consecutiveFailures = 0;
          const messages = sortInboundUpdateMessages(Array.isArray(response?.msgs) ? response.msgs : []);
          for (const message of messages) {
            if (shutdown.stopped) {
              break;
            }
            await this.handleIncomingMessage(message);
          }
          await Promise.all([
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
            this.flushPendingCalendarTimelineSync(),
            this.flushPendingHealthImports(),
            this.flushCriticalHabitsMonitor(account),
            this.flushPriorityAwarenessMonitor(account),
            this.flushMissingContextMonitor(account),
            this.flushDailyReviewPipeline(account),
            this.flushPeriodicReviewPipeline(account),
            this.flushStateBackup(),
            this.flushKnowledgeResurface(account),
            this.flushDecisionReviewMonitor(account),
            this.flushFailureWatchdog(account),
          ]);
        } catch (error) {
          if (shutdown.stopped) {
            break;
          }

          if (isSessionExpiredError(error)) {
            throw new Error("The WeChat session has expired. Run `npm run login` again.");
          }

          consecutiveFailures += 1;
          console.error(`[cyberboss] poll failed: ${formatErrorMessage(error)}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        }
      }
    } finally {
      shutdown.dispose();
      this.clearPendingImageInboundTimers();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    }
  }

  async ensureLocationServerStarted() {
    if (!this.projectServices?.whereabouts) {
      return null;
    }
    await this.projectServices.whereabouts.startServer({
      onAccepted: (result) => this.handleLocationAccepted(result),
    });
    console.log(
      `[cyberboss] locationServer=http://${this.config.locationHost}:${this.config.locationPort} store=${this.config.locationStoreFile}`
    );
    return this.projectServices.whereabouts.server || null;
  }

  async closeLocationServer() {
    if (!this.projectServices?.whereabouts) {
      return;
    }
    await this.projectServices.whereabouts.closeServer();
  }

  handleLocationAccepted(result) {
    if (!this.activeAccountId) {
      return;
    }

    const point = result?.appended?.point || null;
    const movementEvent = result?.appended?.movementEvent || null;
    const triggerText = buildLocationTriggerSystemText(point?.trigger);
    if (!triggerText && !movementEvent) {
      return;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: this.activeAccountId,
      sessionStore,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: this.activeAccountId,
      senderId,
      sessionStore,
    });
    if (!senderId || !workspaceRoot) {
      return;
    }

    if (normalizeText(point?.trigger) === "arrive_home") {
      try {
        const at = normalizeIsoTime(point?.receivedAt) || normalizeIsoTime(point?.timestamp) || new Date().toISOString();
        this.projectServices?.currentState?.recordAssertion({
          state: "arrived_home",
          sourceText: "定位：到家了",
          at,
        });
        this.maybeQueuePlaybookTrigger({
          senderId,
          provider: this.channelAdapter.describe().id,
          receivedAt: at,
        }, "arrived_home");
      } catch (error) {
        console.error(`[cyberboss] location anchor handling failed: ${formatErrorMessage(error)}`);
      }
    }

    if (triggerText && point?.id) {
      this.systemMessageQueue.enqueue({
        id: `location-trigger:${point.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: triggerText,
        createdAt: normalizeIsoTime(point?.receivedAt) || normalizeIsoTime(point?.timestamp) || new Date().toISOString(),
      });
    }

    if (movementEvent) {
      this.systemMessageQueue.enqueue({
        id: `location-move:${movementEvent.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: buildLocationMovementSystemText(movementEvent),
        createdAt: normalizeIsoTime(movementEvent?.movedAt) || new Date().toISOString(),
      });
    }
  }

  async sendTimelineScreenshot({
    senderId = "",
    outputFile = "",
    selector = "",
    range = "",
    date = "",
    week = "",
    month = "",
    category = "",
    subcategory = "",
    width = 0,
    height = 0,
    sidePadding = undefined,
    locale = "",
  } = {}) {
    return this.projectServices.timeline.queueScreenshot({
      userId: senderId,
      outputFile,
      selector,
      range,
      date,
      week,
      month,
      category,
      subcategory,
      width,
      height,
      sidePadding,
      locale,
    }, {});
  }

  async sendLocalFileToCurrentChat({ senderId = "", filePath = "" } = {}) {
    return this.projectServices.channelFile.sendToCurrentChat({
      userId: senderId,
      filePath,
    }, {});
  }

  async handleIncomingMessage(message) {
    const normalized = this.channelAdapter.normalizeIncomingMessage(message);
    if (!normalized) {
      return;
    }

    this.primeDeferredRepliesForSender(normalized);
    await this.handlePreparedMessage(normalized, { allowCommands: true });
  }

  deferSystemReply({ threadId = "", userId = "", text = "", error = null, kind = "plain_reply" }) {
    return this.deferredSystemReplyQueue.enqueue({
      id: `${normalizeCommandArgument(threadId) || "system"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      accountId: this.activeAccountId || this.channelAdapter.resolveAccount().accountId,
      senderId: userId,
      threadId,
      text,
      kind,
      createdAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error || ""),
    });
  }

  primeDeferredRepliesForSender(normalized) {
    if (!normalized?.accountId || !normalized?.senderId || !normalized?.contextToken) {
      return;
    }
    const pendingReplies = this.deferredSystemReplyQueue.drainForSender(normalized.accountId, normalized.senderId);
    if (!pendingReplies.length) {
      return;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setDeferredReplyPrefix(bindingKey, formatDeferredSystemReplyBatch(pendingReplies));
    console.warn(
      `[cyberboss] queued deferred reply prefix sender=${normalized.senderId} count=${pendingReplies.length}`
    );
  }

  async handlePreparedMessage(normalized, { allowCommands }) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setReplyTarget(bindingKey, {
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      provider: normalized.provider,
    });

    const command = parseChannelCommand(normalized.text);
    if (allowCommands && command) {
      await this.dispatchChannelCommand(normalized, command);
      return;
    }
    if (typeof this.autoCaptureIncomingDiary === "function") {
      await this.autoCaptureIncomingDiary(normalized);
    }
    if (typeof this.autoCaptureIncomingTimeline === "function") {
      await this.autoCaptureIncomingTimeline(normalized);
    }
    if (typeof this.observeIncomingPriorityCompletion === "function") {
      this.observeIncomingPriorityCompletion(normalized);
    }
    if (typeof this.observeIncomingCurrentState === "function") {
      this.observeIncomingCurrentState(normalized);
    }
    if (typeof this.observeIncomingFocusProtection === "function") {
      const handled = await this.observeIncomingFocusProtection(normalized);
      if (handled) {
        return;
      }
    }
    if (typeof this.observeIncomingShiftRating === "function") {
      const handled = await this.observeIncomingShiftRating(normalized);
      if (handled) {
        return;
      }
    }
    if (typeof this.observeIncomingMissingContext === "function") {
      const handled = await this.observeIncomingMissingContext(normalized);
      if (handled) {
        return;
      }
    }

    const djHandled = await this.handleDecisionJournalIntercept(normalized);
    if (djHandled) {
      return;
    }

    const patternHandled = await this.handlePatternIntercept(normalized);
    if (patternHandled) {
      return;
    }

    await this.handleWinsLedgerIntercept(normalized);

    const playbookHandled = await this.handlePlaybookQuickStart(normalized);
    if (playbookHandled) {
      return;
    }

    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    await this.rollOverDailyThreadIfNeeded({ bindingKey, workspaceRoot, normalized });
    const prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot);
    if (!prepared) {
      return;
    }

    if (!this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      const routing = this.modelRouter.decide({
        text: prepared.originalText || prepared.text,
        senderId: prepared.senderId,
        provider: prepared.provider,
        attachments: prepared.attachments,
        attachmentFailures: prepared.attachmentFailures,
      });
      if (routing.mode === "deepseek") {
        const sent = await this.dispatchDeepSeekDailyReply({ prepared, routing });
        if (sent) {
          return;
        }
      }
    }

    if (shouldBatchImageOnlyInbound(prepared)) {
      this.enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared });
      return;
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot) && isPlainTextPreparedMessage(prepared)) {
      const merged = await this.flushPendingImageInboundBatch({
        bindingKey,
        workspaceRoot,
        trailingPrepared: prepared,
      });
      if (merged) {
        return;
      }
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot)) {
      await this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot });
    }

    await this.routePreparedInbound({ bindingKey, workspaceRoot, prepared });
  }

  async rollOverDailyThreadIfNeeded({ bindingKey, workspaceRoot, normalized }) {
    if (!this.config.dailyThreadRollover || normalized?.provider === "system") {
      return false;
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const localDate = resolveCaptureLocalDateTime(normalized?.receivedAt, this.config).date;
    const previousDate = sessionStore.getThreadActivityDateForWorkspace(bindingKey, workspaceRoot);
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);

    if (previousDate && previousDate !== localDate && threadId) {
      if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
        await this.runtimeAdapter.startFreshThreadDraft({ bindingKey, workspaceRoot });
      }
      sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      console.log(
        `[cyberboss] daily thread rollover workspace=${workspaceRoot} previousDate=${previousDate} localDate=${localDate}`
      );
    }

    sessionStore.setThreadActivityDateForWorkspace(bindingKey, workspaceRoot, localDate);
    return Boolean(previousDate && previousDate !== localDate && threadId);
  }

  async autoCaptureIncomingDiary(normalized) {
    if (!this.config.diaryAutoCapture) {
      return;
    }
    const text = normalizeCommandArgument(normalized?.text);
    if (!text) {
      return;
    }
    try {
      const captureTime = resolveCaptureLocalDateTime(normalized?.receivedAt, this.config);
      if (this.config.diaryAutoCaptureTarget === "inbox" && this.projectServices?.dailyInbox) {
        await this.projectServices.dailyInbox.append({
          text,
          date: captureTime.date,
          time: captureTime.time,
          provider: normalized?.provider,
          senderId: normalized?.senderId,
        });
        console.log(`[cyberboss] daily inbox captured provider=${normalized.provider || ""} sender=${normalized.senderId || ""}`);
        return;
      }
      if (this.projectServices?.diary) {
        await this.projectServices.diary.append({
          title: `${this.channelAdapter.describe().id} 自动记录`,
          text: buildAutoDiaryCaptureText(normalized, this.config),
          date: captureTime.date,
          time: captureTime.time,
        });
        console.log(`[cyberboss] diary auto-captured provider=${normalized.provider || ""} sender=${normalized.senderId || ""}`);
      }
    } catch (error) {
      console.error(`[cyberboss] diary auto-capture failed: ${formatErrorMessage(error)}`);
    }
  }

  async autoCaptureIncomingTimeline(normalized) {
    if (!this.config.timelineAutoCapture || !this.projectServices?.timelineAutoCapture) {
      return;
    }
    const text = normalizeCommandArgument(normalized?.text);
    if (!text) {
      return;
    }
    try {
      const result = await this.projectServices.timelineAutoCapture.captureMessage({
        text,
        receivedAt: normalized?.receivedAt,
        senderId: normalized?.senderId,
        provider: normalized?.provider,
      });
      if (result.events?.length) {
        this.projectServices.priorityAwareness?.observeEvents({
          events: result.events,
        });
        console.log(`[cyberboss] timeline auto-captured count=${result.events.length} sender=${normalized.senderId || ""}`);
      } else if (result.pending) {
        console.log(`[cyberboss] timeline auto-capture pending sender=${normalized.senderId || ""}`);
      }
      if (result.wokeUp || looksLikeWakeReentryText(text)) {
        this.projectServices.priorityAwareness?.queueWakeReentry({
          accountId: normalized?.accountId || this.activeAccountId || this.channelAdapter.resolveAccount().accountId,
        }, {
          receivedAt: normalized?.receivedAt,
        });
      }
    } catch (error) {
      console.error(`[cyberboss] timeline auto-capture failed: ${formatErrorMessage(error)}`);
    }
  }

  isTurnDispatchBlocked(bindingKey, workspaceRoot, { ignoreBoundary = false } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!ignoreBoundary && scopeKey && this.turnBoundaryScopeKeys?.has(scopeKey)) {
      return true;
    }
    if (this.turnGateStore.isPending(bindingKey, workspaceRoot)) {
      return true;
    }
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    return threadState?.status === "running" || hasRpcId(threadState?.pendingApproval?.requestId);
  }

  async dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared }) {
    const pendingScopeKey = this.turnGateStore.begin(bindingKey, workspaceRoot);
    let runtimeTurn = null;
    await this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});

    try {
      const model = this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;
      runtimeTurn = await this.buildRuntimeTurn({ prepared, model });
      const sendTurn = typeof this.runtimeAdapter.sendTurn === "function"
        ? this.runtimeAdapter.sendTurn.bind(this.runtimeAdapter)
        : this.runtimeAdapter.sendTextTurn.bind(this.runtimeAdapter);
      const turn = await sendTurn({
        bindingKey,
        workspaceRoot,
        text: runtimeTurn.text,
        attachments: runtimeTurn.attachments,
        model,
        metadata: {
          workspaceId: prepared.workspaceId,
          accountId: prepared.accountId,
          senderId: prepared.senderId,
        },
      });
      this.runtimeContextStore?.setActiveContext?.({
        workspaceRoot,
        runtimeId: this.runtimeAdapter.describe().id,
        threadId: turn.threadId,
        bindingKey,
        accountId: prepared.accountId,
        senderId: prepared.senderId,
      });
      this.turnGateStore.attachThread(pendingScopeKey, turn.threadId);
      const replyTarget = {
        userId: prepared.senderId,
        contextToken: prepared.contextToken,
        provider: prepared.provider,
      };
      if (turn.turnId) {
        this.streamDelivery.bindReplyTargetForTurn({
          threadId: turn.threadId,
          turnId: turn.turnId,
          target: replyTarget,
        });
      } else {
        this.streamDelivery.queueReplyTargetForThread(turn.threadId, replyTarget);
      }
      this.rememberFallbackContext({
        threadId: turn.threadId,
        turnId: turn.turnId,
        text: prepared.text,
        provider: prepared.provider,
        replyTarget,
      });
      return true;
    } catch (error) {
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      const messageText = error instanceof Error ? error.message : String(error || "unknown error");
      const fallbackSent = await this.sendDeepSeekFallback({
        text: prepared.text || runtimeTurn?.text,
        reason: messageText,
        provider: prepared.provider,
        replyTarget: {
          userId: prepared.senderId,
          contextToken: prepared.contextToken,
          provider: prepared.provider,
        },
      });
      if (!fallbackSent) {
        await this.channelAdapter.sendText({
          userId: prepared.senderId,
          text: `❌ Request failed\n${messageText}`,
          contextToken: prepared.contextToken,
        }).catch(() => {});
      }
      return false;
    }
  }

  async handleDecisionJournalIntercept(normalized) {
    const senderId = normalizeText(normalized.senderId);
    const userText = normalizeText(normalized.text);
    const contextToken = normalizeText(normalized.contextToken);
    const hasAttachments = Array.isArray(normalized.attachments) && normalized.attachments.length > 0;

    if (this.decisionJournalState.hasPending(senderId)) {
      if (userText && !hasAttachments && isDecisionJournalConfirmation(userText)) {
        const pending = this.decisionJournalState.getPending(senderId);
        this.decisionJournalState.clearPending(senderId);
        try {
          await this.projectServices.decisionJournal.record({
            decision: pending.text,
            date: pending.date,
            context: "Recorded via Decision Journal bridge trigger.",
          });
          await this.channelAdapter.sendText({
            userId: senderId,
            text: "好，已记录到 Decision Journal ✓",
            contextToken,
          });
          await this.autoAddPatternEvidence({
            domain: "decision-patterns",
            note: `Decision recorded: ${pending.text.slice(0, 80)}, date: ${pending.date}`,
            source: "decision-journal",
            date: pending.date,
          });
        } catch (err) {
          await this.channelAdapter.sendText({
            userId: senderId,
            text: `记录失败：${err instanceof Error ? err.message : String(err)}`,
            contextToken,
          });
        }
        return true;
      }
      this.decisionJournalState.clearPending(senderId);
    }

    if (userText && !hasAttachments && detectDecisionTrigger(userText)) {
      await this.channelAdapter.sendText({
        userId: senderId,
        text: "这看起来像一个重要决定，要不要记录到 Decision Journal？",
        contextToken,
      });
      this.decisionJournalState.setPending(senderId, {
        text: userText,
        date: new Date().toISOString().slice(0, 10),
      });
    }

    return false;
  }

  async handlePatternIntercept(normalized) {
    const senderId = normalizeText(normalized.senderId);
    const userText = normalizeText(normalized.text);
    const contextToken = normalizeText(normalized.contextToken);
    const hasAttachments = Array.isArray(normalized.attachments) && normalized.attachments.length > 0;

    if (!userText || hasAttachments || !detectPatternViewTrigger(userText)) {
      return false;
    }
    try {
      const result = this.projectServices.patternLedger.read({});
      const summary = formatPatternList(result.patterns || []);
      await this.channelAdapter.sendText({
        userId: senderId,
        text: `Pattern Ledger（共 ${result.count} 条）：\n\n${summary}`,
        contextToken,
      });
    } catch (err) {
      await this.channelAdapter.sendText({
        userId: senderId,
        text: `读取 Pattern Ledger 失败：${err instanceof Error ? err.message : String(err)}`,
        contextToken,
      });
    }
    return true;
  }

  async autoAddPatternEvidence({ domain, note, source, date }) {
    try {
      const result = this.projectServices.patternLedger.read({});
      const allPatterns = result.patterns || [];
      const matched = matchPatternsByDomain(allPatterns, domain).slice(0, 3);
      if (matched.length) {
        for (const pattern of matched) {
          this.projectServices.patternLedger.addEvidence({
            patternId: pattern.id,
            evidence: [{ note, source, date }],
          });
        }
      } else {
        this.unmatchedEvidenceStore.append({ originDomain: domain, note, source, date });
      }
    } catch {
      // best-effort, silent on failure
    }
  }

  async handleWinsLedgerIntercept(normalized) {
    const senderId = normalizeText(normalized.senderId);
    const userText = normalizeText(normalized.text);
    const contextToken = normalizeText(normalized.contextToken);
    const hasAttachments = Array.isArray(normalized.attachments) && normalized.attachments.length > 0;

    if (this.winsLedgerState.hasPending(senderId)) {
      const parsed = userText && !hasAttachments ? parseWinsResponse(userText) : null;
      if (parsed) {
        const pending = this.winsLedgerState.getPending(senderId);
        this.winsLedgerState.clearPending(senderId);
        try {
          await this.projectServices.wins.record({
            task: pending.task,
            domain: pending.domain,
            success_factor: parsed.success_factor,
            note: parsed.note,
            date: pending.date,
          });
          await this.channelAdapter.sendText({
            userId: senderId,
            text: "✓ 已记录到 Wins Ledger",
            contextToken,
          });
          await this.autoAddPatternEvidence({
            domain: pending.domain,
            note: `Win: ${pending.task}, success_factor: ${factor}, date: ${pending.date}`,
            source: "wins-ledger",
            date: pending.date,
          });
        } catch (err) {
          await this.channelAdapter.sendText({
            userId: senderId,
            text: `记录失败：${err instanceof Error ? err.message : String(err)}`,
            contextToken,
          });
        }
      } else {
        this.winsLedgerState.clearPending(senderId);
      }
      return;
    }

    if (userText && !hasAttachments) {
      const win = detectWinTrigger(userText);
      if (win) {
        await this.channelAdapter.sendText({
          userId: senderId,
          text: buildWinsPrompt(),
          contextToken,
        });
        this.winsLedgerState.setPending(senderId, {
          task: win.task,
          domain: win.domain,
          date: new Date().toISOString().slice(0, 10),
        });
      }
    }
  }

  async buildRuntimeTurn({ prepared, model = "" }) {
    if (prepared?.provider === "system") {
      return {
        text: String(prepared.text || "").trim(),
        attachments: [],
      };
    }
    const visionContext = await resolveVisionContext({
      prepared,
      config: this.config,
      runtimeAdapter: this.runtimeAdapter,
      model,
    });
    let text = assembleRuntimeTurnText({
      prepared,
      config: this.config,
      visionContext,
    });
    const temporalContext = typeof this.buildRuntimeTemporalContext === "function"
      ? await this.buildRuntimeTemporalContext(prepared)
      : "";
    if (temporalContext) {
      text = `${text}\n\n---\nTemporal context for this reply:\n${temporalContext}`;
    }
    const originalText = String(prepared?.originalText || prepared?.text || "").trim();
    if (detectDecisionTrigger(originalText)) {
      text = text + "\n\n" + buildDecisionTriggerAnnotation();
    }
    return {
      text,
      attachments: Array.isArray(visionContext.runtimeAttachments) ? visionContext.runtimeAttachments : [],
      visionContext,
    };
  }

  async buildRuntimeTemporalContext(prepared) {
    const dailyState = this.projectServices?.dailyState;
    if (!dailyState || typeof dailyState.analyze !== "function") {
      return "";
    }
    const cacheKey = Math.floor(Date.now() / 45_000);
    if (this.temporalContextCache?.key === cacheKey) {
      return this.temporalContextCache.text;
    }
    try {
      const receivedAt = parseDateOrNow(prepared?.receivedAt);
      const local = resolveCaptureLocalDateTime(receivedAt.toISOString(), this.config);
      const analysis = await dailyState.analyze({ date: local.date, now: receivedAt });
      const ctx = analysis?.temporalContext || {};
      const tomorrowMorning = await this.readTomorrowMorningCalendarContext(local.date);
      const lines = [
        `Local now: ${ctx.localNow || `${local.date} ${local.time}`}`,
        `Day type / schedule mode: ${ctx.dayType || "unknown"}`,
      ];
      if (ctx.currentEvent) {
        lines.push(`Currently in calendar event: ${formatTemporalCalendarEvent(ctx.currentEvent)}`);
      } else {
        lines.push("Currently in calendar event: none known");
      }
      const remaining = Array.isArray(ctx.remainingEventsToday) ? ctx.remainingEventsToday : [];
      if (remaining.length) {
        lines.push("Remaining known events today:");
        for (const event of remaining.slice(0, 5)) {
          lines.push(`- ${formatTemporalCalendarEvent(event)}`);
        }
      } else {
        lines.push("Remaining known events today: none known");
      }
      if (tomorrowMorning.length) {
        lines.push("Known events tomorrow morning:");
        for (const event of tomorrowMorning.slice(0, 5)) {
          lines.push(`- ${formatTemporalCalendarEvent(event)}`);
        }
      } else {
        lines.push("Known events tomorrow morning: none known");
      }
      if (ctx.contextQuestionTiming) {
        const blocking = ctx.contextQuestionTiming.blockingEvent
          ? `; blocked by ${formatTemporalCalendarEvent(ctx.contextQuestionTiming.blockingEvent)}`
          : "";
        lines.push(`Daily energy/mood question timing: ${ctx.contextQuestionTiming.dueAt} (${ctx.contextQuestionTiming.reason || "unknown"}${blocking})`);
      }
      lines.push(...this.buildCurrentStateContextLines(receivedAt));
      lines.push("Use this context to reason about today/tonight/tomorrow. Do not treat past calendar events as future tasks. If the user explicitly states a current state, it overrides older assumptions.");
      const text = lines.join("\n");
      this.temporalContextCache = { key: cacheKey, text };
      return text;
    } catch (error) {
      console.error(`[cyberboss] temporal context build failed: ${formatErrorMessage(error)}`);
      return "";
    }
  }

  buildCurrentStateContextLines(now = new Date()) {
    const currentState = this.projectServices?.currentState;
    if (!currentState) {
      return [];
    }
    const lines = [];
    try {
      const current = currentState.current({ now });
      if (current && current.fresh) {
        lines.push(
          `Latest explicit state from ${this.config.userName || "the user"}: ${current.label} (${current.state}) — she said "${current.sourceText}" ${current.ageMinutes} minutes ago.`,
        );
        if (["commuting_to_work", "at_work", "commuting_home"].includes(current.state)) {
          lines.push("HARD RULE: she is up and out. This overrides every sleep/rest/wake-up assumption from calendar or older messages. Never suggest staying in bed, getting up slowly, going back to sleep, or napping right now. Support what she is actually doing.");
        }
        if (current.state === "going_to_sleep") {
          lines.push("She said she is going to sleep. Do not ask questions or send non-urgent reminders until she speaks again.");
        }
      }
      const sleep = currentState.lastSleep({ now });
      if (sleep && sleep.approxHours !== null && sleep.approxHours !== undefined) {
        lines.push(
          `Last night per her own report: fell asleep around ${formatHourText(sleep.sleptAtHour)}, up around ${formatHourText(sleep.wokeAtHour)} (~${sleep.approxHours}h sleep). If this is short, acknowledge it practically; do not give bedtime advice while she is out or working.`,
        );
      }
    } catch (error) {
      console.error(`[cyberboss] current state context failed: ${formatErrorMessage(error)}`);
    }
    return lines;
  }

  async readTomorrowMorningCalendarContext(localDate) {
    const calendar = this.projectServices?.calendar;
    if (!calendar || typeof calendar.read !== "function") {
      return [];
    }
    const tomorrow = addDaysDateText(localDate, 1);
    try {
      const result = await calendar.read({
        start: `${tomorrow}T00:00:00`,
        end: `${tomorrow}T12:00:00`,
        includeNotes: false,
      });
      const zone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
      return (Array.isArray(result?.events) ? result.events : [])
        .filter((event) => !event?.isAllDay)
        .map((event) => {
          const start = parseDateOrNow(event.start);
          const end = parseDateOrNow(event.end);
          return {
            title: normalizeCommandArgument(event.title) || "(untitled)",
            calendar: normalizeCommandArgument(event.calendar),
            start: formatTimePart(start, zone),
            end: formatTimePart(end, zone),
          };
        })
        .sort((left, right) => left.start.localeCompare(right.start));
    } catch (error) {
      console.error(`[cyberboss] tomorrow calendar context failed: ${formatErrorMessage(error)}`);
      return [];
    }
  }

  async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  hasPendingImageInbound(bindingKey, workspaceRoot) {
    return this.pendingImageInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingImageInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
      timer: null,
    };
    current.messages.push(clonePreparedInboundMessage(prepared));
    this.pendingImageInboundByScope.set(scopeKey, current);
    this.schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = INBOUND_IMAGE_BATCH_IDLE_MS) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft) {
      return;
    }
    if (draft.timer) {
      clearTimeout(draft.timer);
    }
    draft.timer = setTimeout(() => {
      void this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot }).catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[cyberboss] image inbound debounce flush failed ${message}`);
      });
    }, Math.max(0, Number(delayMs) || 0));
    this.pendingImageInboundByScope.set(scopeKey, draft);
  }

  clearPendingImageInboundTimer(scopeKey) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft?.timer) {
      return;
    }
    clearTimeout(draft.timer);
    draft.timer = null;
  }

  clearPendingImageInboundTimers() {
    for (const [scopeKey] of this.pendingImageInboundByScope.entries()) {
      this.clearPendingImageInboundTimer(scopeKey);
    }
  }

  async flushPendingImageInboundBatch({ bindingKey = "", workspaceRoot = "", trailingPrepared = null } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const draft = scopeKey ? this.pendingImageInboundByScope.get(scopeKey) || null : null;
    if (!draft?.bindingKey || !draft?.workspaceRoot) {
      if (scopeKey) {
        this.pendingImageInboundByScope.delete(scopeKey);
      }
      return false;
    }

    this.clearPendingImageInboundTimer(scopeKey);
    this.pendingImageInboundByScope.delete(scopeKey);

    const queued = Array.isArray(draft.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return false;
    }

    const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
    if (!batchMessages.length) {
      return false;
    }

    if (remainingMessages.length) {
      this.pendingImageInboundByScope.set(scopeKey, {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        messages: remainingMessages,
        timer: null,
      });
    }

    const prepared = buildMergedInboundPrepared({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      messages: batchMessages,
      trailingPrepared,
    });
    await this.routePreparedInbound({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      prepared,
    });

    if (remainingMessages.length) {
      await this.flushPendingImageInboundBatch({
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
      });
    }

    return true;
  }

  bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
    };
    current.messages.push({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
      messageId: prepared.messageId,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
      originalText: prepared.originalText,
      text: prepared.text,
      attachments: Array.isArray(prepared.attachments) ? prepared.attachments : [],
      attachmentFailures: Array.isArray(prepared.attachmentFailures) ? prepared.attachmentFailures : [],
      receivedAt: prepared.receivedAt,
    });
    this.pendingInboundByScope.set(scopeKey, current);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  hasPendingInboundMessage(bindingKey, workspaceRoot) {
    return this.pendingInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  async flushPendingInboundMessages({ bindingKey = "", workspaceRoot = "", ignoreBoundary = false } = {}) {
    const targetScopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const scopeEntries = targetScopeKey
      ? [[targetScopeKey, this.pendingInboundByScope.get(targetScopeKey) || null]]
      : [...this.pendingInboundByScope.entries()];

    for (const [scopeKey, draft] of scopeEntries) {
      if (!draft?.bindingKey || !draft?.workspaceRoot) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      if (this.isTurnDispatchBlocked(draft.bindingKey, draft.workspaceRoot, { ignoreBoundary })) {
        continue;
      }
      const pendingDispatch = this.mergePendingInboundDraft(draft);
      if (!pendingDispatch?.prepared) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      this.pendingInboundByScope.delete(scopeKey);
      const dispatched = await this.dispatchPreparedTurn({
        bindingKey: pendingDispatch.prepared.bindingKey,
        workspaceRoot: pendingDispatch.prepared.workspaceRoot,
        prepared: {
          workspaceId: pendingDispatch.prepared.workspaceId,
          accountId: pendingDispatch.prepared.accountId,
          senderId: pendingDispatch.prepared.senderId,
          contextToken: pendingDispatch.prepared.contextToken,
          provider: pendingDispatch.prepared.provider,
          originalText: pendingDispatch.prepared.originalText,
          text: pendingDispatch.prepared.text,
          attachments: pendingDispatch.prepared.attachments,
          attachmentFailures: pendingDispatch.prepared.attachmentFailures,
          receivedAt: pendingDispatch.prepared.receivedAt,
        },
      });
      if (!dispatched) {
        this.pendingInboundByScope.set(scopeKey, draft);
        continue;
      }
      if (pendingDispatch.remainingMessages.length) {
        this.pendingInboundByScope.set(scopeKey, {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: pendingDispatch.remainingMessages,
        });
      }
    }
  }

  mergePendingInboundDraft(draft) {
    const queued = Array.isArray(draft?.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return null;
    }
    if (queued.every((message) => shouldBatchImageOnlyInbound(message))) {
      const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
      return {
        prepared: buildMergedInboundPrepared({
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: batchMessages,
        }),
        remainingMessages,
      };
    }

    if (queued.length === 1) {
      return {
        prepared: {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          ...queued[0],
        },
        remainingMessages: [],
      };
    }

    const latest = queued[queued.length - 1];
    const blocks = queued
      .map((message) => String(message.text || "").trim())
      .filter(Boolean);

    return {
      prepared: {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        ...latest,
        text: [
          "Multiple newer WeChat messages arrived while you were still handling the previous turn.",
          "Treat the following blocks as one ordered batch of fresh user input and respond once after considering all of them.",
          "",
          blocks.join("\n\n"),
        ].join("\n").trim(),
      },
      remainingMessages: [],
    };
  }

  async prepareIncomingMessageForRuntime(normalized, workspaceRoot) {
    if (normalized?.provider === "system") {
      return {
        ...normalized,
        originalText: normalized.text,
        text: String(normalized.text || "").trim(),
        attachments: [],
        attachmentFailures: [],
      };
    }

    const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
    if (!attachments.length) {
      return buildInboundDraft(normalized);
    }

    const persisted = await persistIncomingWeixinAttachments({
      attachments,
      stateDir: this.config.stateDir,
      cdnBaseUrl: this.config.weixinCdnBaseUrl,
      messageId: normalized.messageId,
      receivedAt: normalized.receivedAt,
    });

    if (!persisted.saved.length && persisted.failed.length && !String(normalized.text || "").trim()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    const prepared = buildInboundDraft(normalized, {
      attachments: persisted.saved,
      attachmentFailures: persisted.failed,
    });
    if (!prepared.originalText && !prepared.attachments.length && prepared.attachmentFailures.length) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    return prepared;
  }

  async flushPendingSystemMessages() {
    const pendingMessages = this.systemMessageDispatcher?.drainPending() || [];
    for (const message of pendingMessages) {
      try {
        const dispatched = await this.dispatchSystemMessage(message);
        if (!dispatched) {
          this.systemMessageDispatcher.requeue(message);
        }
      } catch {
        this.systemMessageDispatcher?.requeue(message);
      }
    }
  }

  async flushPendingTimelineScreenshots(account) {
    const pendingJobs = this.timelineScreenshotQueue.drainForAccount(account.accountId);
    for (const job of pendingJobs) {
      try {
        const captured = await this.projectServices.timeline.captureScreenshot({
          outputFile: job.outputFile,
          selector: job.selector,
          range: job.range,
          date: job.date,
          week: job.week,
          month: job.month,
          category: job.category,
          subcategory: job.subcategory,
          width: job.width,
          height: job.height,
          sidePadding: job.sidePadding,
          locale: job.locale,
        });
        await this.sendLocalFileToCurrentChat({
          senderId: job.senderId,
          filePath: captured.outputFile,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error || "unknown error");
        console.error(`[cyberboss] timeline screenshot failed job=${job.id} ${messageText}`);
        await this.channelAdapter.sendTyping({
          userId: job.senderId,
          status: 0,
        }).catch(() => {});
        await this.channelAdapter.sendText({
          userId: job.senderId,
          text: `❌ Timeline screenshot failed\n${messageText}`,
          preserveBlock: true,
        }).catch(() => {});
      }
    }
  }

  async flushPendingHealthImports() {
    if (!this.config.healthAutoImport || !this.projectServices?.health) {
      return;
    }
    const intervalMs = Number(this.config.healthImportIntervalMs) || 300_000;
    if (this.lastHealthImportCheckAtMs && Date.now() - this.lastHealthImportCheckAtMs < intervalMs) {
      return;
    }
    this.lastHealthImportCheckAtMs = Date.now();
    try {
      const result = await this.projectServices.health.importPending({ limit: 20 });
      if (result.imported?.length) {
        console.log(`[cyberboss] health imports completed count=${result.imported.length}`);
      }
    } catch (error) {
      console.error(`[cyberboss] health import failed: ${formatErrorMessage(error)}`);
    }
  }

  async flushPendingCalendarTimelineSync() {
    if (!this.config.calendarTimelineSync || !this.projectServices?.calendarTimelineSync) {
      return;
    }
    const intervalMs = Number(this.config.calendarTimelineSyncIntervalMs) || 600_000;
    if (this.lastCalendarTimelineSyncAtMs && Date.now() - this.lastCalendarTimelineSyncAtMs < intervalMs) {
      return;
    }
    this.lastCalendarTimelineSyncAtMs = Date.now();
    try {
      const result = await this.projectServices.calendarTimelineSync.sync();
      if (result.imported?.length) {
        console.log(`[cyberboss] calendar timeline sync completed count=${result.imported.length}`);
      }
    } catch (error) {
      console.error(`[cyberboss] calendar timeline sync failed: ${formatErrorMessage(error)}`);
    }
  }

  resolveLongPollTimeoutMs() {
    if (this.systemMessageDispatcher?.hasPending()) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    if (this.activeAccountId && this.timelineScreenshotQueue.hasPendingForAccount(this.activeAccountId)) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }

    const nextDueAtMs = this.reminderQueue.peekNextDueAtMs();
    if (!nextDueAtMs) {
      return DEFAULT_LONG_POLL_TIMEOUT_MS;
    }

    const remainingMs = nextDueAtMs - Date.now();
    if (remainingMs <= MIN_LONG_POLL_TIMEOUT_MS) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    return Math.max(MIN_LONG_POLL_TIMEOUT_MS, Math.min(DEFAULT_LONG_POLL_TIMEOUT_MS, remainingMs));
  }

  async flushDueReminders(account) {
    const dueReminders = this.reminderQueue
      .listDue(Date.now())
      .filter((reminder) => reminder.accountId === account.accountId);

    for (const reminder of dueReminders) {
      try {
        const focusDelay = this.projectServices?.focusProtection?.shouldDelayReminder?.(reminder, new Date());
        if (focusDelay?.delay) {
          this.reminderQueue.enqueue({
            ...reminder,
            dueAtMs: Date.now() + (Number(this.config.focusProtectionReminderSnoozeMs) || 5 * 60_000),
          });
          console.log(`[cyberboss] reminder delayed by focus protection reminder=${reminder.id}`);
          continue;
        }
        this.systemMessageQueue.enqueue({
          id: `reminder:${reminder.id}`,
          accountId: reminder.accountId,
          senderId: reminder.senderId,
          workspaceRoot: this.resolveReminderWorkspaceRoot(reminder),
          text: buildReminderSystemTrigger(reminder, this.config),
          createdAt: new Date().toISOString(),
        });
      } catch {
        this.reminderQueue.enqueue({
          ...reminder,
          dueAtMs: Date.now() + 5_000,
        });
      }
    }
  }

  async flushCriticalHabitsMonitor(account) {
    try {
      await this.criticalHabitsMonitor.check(account);
    } catch (error) {
      console.error(`[cyberboss] critical habits monitor failed: ${formatErrorMessage(error)}`);
    }
  }

  async flushPriorityAwarenessMonitor(account) {
    try {
      await this.projectServices?.priorityAwareness?.check(account);
    } catch (error) {
      console.error(`[cyberboss] priority awareness monitor failed: ${formatErrorMessage(error)}`);
    }
  }

  async flushMissingContextMonitor(account) {
    try {
      await this.projectServices?.missingContext?.check(account);
    } catch (error) {
      console.error(`[cyberboss] missing context monitor failed: ${formatErrorMessage(error)}`);
    }
  }

  async flushFailureWatchdog(account) {
    try {
      await this.failureWatchdog?.check(account);
    } catch (error) {
      console.error(`[cyberboss] failure watchdog failed: ${formatErrorMessage(error)}`);
    }
  }

  async flushDailyReviewPipeline(account) {
    try {
      await this.dailyReviewPipeline?.check(account);
    } catch (error) {
      console.error(`[cyberboss] daily review pipeline failed: ${formatErrorMessage(error)}`);
    }
  }

  async flushPeriodicReviewPipeline(account) {
    try {
      await this.periodicReviewPipeline?.check(account);
    } catch (error) {
      console.error(`[cyberboss] periodic review pipeline failed: ${formatErrorMessage(error)}`);
    }
  }

  async flushStateBackup() {
    try {
      await this.stateBackup?.check();
    } catch (error) {
      console.error(`[cyberboss] state backup check failed: ${formatErrorMessage(error)}`);
    }
  }

  async flushKnowledgeResurface(account) {
    try {
      await this.knowledgeResurface?.check(account);
    } catch (error) {
      console.error(`[cyberboss] knowledge resurface failed: ${formatErrorMessage(error)}`);
    }
  }

  async flushDecisionReviewMonitor(account) {
    try {
      await this.decisionReviewMonitor?.check(account);
    } catch (error) {
      console.error(`[cyberboss] decision review monitor failed: ${formatErrorMessage(error)}`);
    }
  }

  observeIncomingCurrentState(normalized) {
    try {
      const result = this.projectServices?.currentState?.observeMessage({
        text: normalized?.text,
        receivedAt: normalized?.receivedAt,
        provider: normalized?.provider,
        senderId: normalized?.senderId,
      });
      if (result?.stateUpdated && result.state) {
        this.maybeQueuePlaybookTrigger(normalized, result.state);
      }
    } catch (error) {
      console.error(`[cyberboss] current state observation failed: ${formatErrorMessage(error)}`);
    }
  }

  // When an anchor state fires (到家了 / 睡醒了 ...), surface the pre-decided
  // playbook default as a single low-decision-cost prompt.
  maybeQueuePlaybookTrigger(normalized, anchorState) {
    try {
      const playbook = this.projectServices?.playbook;
      if (!playbook || !this.activeAccountId || !normalized?.senderId) {
        return;
      }
      const now = parseDateOrNow(normalized?.receivedAt);
      const rule = playbook.matchAnchor({ anchor: anchorState, now });
      if (!rule) {
        return;
      }
      const focus = this.projectServices?.focusProtection?.isProtected?.({
        senderId: normalized?.senderId,
        provider: normalized?.provider,
        now,
      });
      if (focus?.protected) {
        return;
      }
      const workspaceRoot = normalizeText(this.config.workspaceRoot);
      this.systemMessageQueue.enqueue({
        id: `playbook:${rule.id}:${crypto.randomUUID()}`,
        accountId: this.activeAccountId,
        senderId: normalized.senderId,
        workspaceRoot,
        text: buildPlaybookTrigger(rule, PLAYBOOK_ANCHOR_LABELS[anchorState] || anchorState, this.config.userName),
        createdAt: now.toISOString(),
      });
      playbook.recordPrompt(rule, now);
      console.log(`[cyberboss] playbook trigger queued rule=${rule.id} anchor=${anchorState}`);
    } catch (error) {
      console.error(`[cyberboss] playbook trigger failed: ${formatErrorMessage(error)}`);
    }
  }

  // A bare digit reply to a fresh playbook prompt starts the focus session
  // right here at the bridge - no model round-trip, no routing, no failure mode.
  async handlePlaybookQuickStart(normalized) {
    try {
      const playbook = this.projectServices?.playbook;
      const focus = this.projectServices?.focusProtection;
      if (!playbook || !focus || !normalized?.senderId) {
        return false;
      }
      const text = normalizeText(normalized?.text);
      if (!/^(1|好|好的|开始|开始吧|ok|go)$/i.test(text)) {
        return false;
      }
      const now = parseDateOrNow(normalized?.receivedAt);
      const pending = playbook.pendingQuickStart({ now });
      if (!pending) {
        return false;
      }
      const active = focus.isProtected?.({
        senderId: normalized.senderId,
        provider: normalized.provider,
        now,
      });
      if (active?.protected) {
        return false;
      }
      const result = await focus.startQuick({
        task: pending.task,
        minutes: pending.minutes,
        now,
        sourceText: `playbook:${pending.ruleId}`,
      });
      playbook.consumeQuickStart();
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `好，${pending.label}，现在开始计时。${result.minutes} 分钟后我来接你收尾。`,
        contextToken: normalized.contextToken || normalized.senderId,
      });
      console.log(`[cyberboss] playbook quick start task=${pending.task} minutes=${result.minutes}`);
      return true;
    } catch (error) {
      console.error(`[cyberboss] playbook quick start failed: ${formatErrorMessage(error)}`);
      return false;
    }
  }

  observeIncomingPriorityCompletion(normalized) {
    try {
      const result = this.projectServices?.priorityAwareness?.observeMessage({
        text: normalized?.text,
        receivedAt: normalized?.receivedAt,
      });
      if (result?.updated?.length) {
        console.log(`[cyberboss] priority awareness completed=${result.updated.join(",")}`);
      }
    } catch (error) {
      console.error(`[cyberboss] priority awareness message observation failed: ${formatErrorMessage(error)}`);
    }
  }

  async observeIncomingFocusProtection(normalized) {
    try {
      const result = await this.projectServices?.focusProtection?.observeIncoming(normalized);
      if (result?.handled) {
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: result.reply,
          contextToken: normalized.contextToken,
        });
        console.log(`[cyberboss] focus protection handled sender=${normalized?.senderId || ""}`);
        return true;
      }
    } catch (error) {
      console.error(`[cyberboss] focus protection observation failed: ${formatErrorMessage(error)}`);
    }
    return false;
  }

  async observeIncomingShiftRating(normalized) {
    try {
      const result = await this.projectServices?.shiftRating?.observeIncoming(normalized);
      if (result?.handled) {
        console.log(`[cyberboss] shift rating prompt sent sender=${normalized?.senderId || ""}`);
        return true;
      }
    } catch (error) {
      console.error(`[cyberboss] shift rating observation failed: ${formatErrorMessage(error)}`);
    }
    return false;
  }

  async observeIncomingMissingContext(normalized) {
    try {
      const result = await this.projectServices?.missingContext?.observeIncoming(normalized);
      if (result?.handled) {
        console.log(`[cyberboss] missing context answer captured sender=${normalized?.senderId || ""}`);
        return true;
      }
    } catch (error) {
      console.error(`[cyberboss] missing context observation failed: ${formatErrorMessage(error)}`);
    }
    return false;
  }

  resolveReminderWorkspaceRoot(reminder) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: reminder.accountId,
      senderId: reminder.senderId,
    });
    return this.runtimeAdapter.getSessionStore().getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async dispatchSystemMessage(message) {
    const prepared = this.systemMessageDispatcher?.buildPreparedMessage(message, this.channelAdapter.getKnownContextTokens()[message.senderId] || "");
    if (!prepared) {
      throw new Error("system message could not be prepared");
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
    });
    const workspaceRoot = prepared.workspaceRoot || this.resolveWorkspaceRoot(bindingKey);
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  async dispatchChannelCommand(normalized, command) {
    switch (command.name) {
      case "bind":
        await this.handleBindCommand(normalized, command);
        return;
      case "status":
        await this.handleStatusCommand(normalized);
        return;
      case "usage":
        await this.handleUsageCommand(normalized);
        return;
      case "codex":
        await this.handleRoutingCommand(normalized, "codex");
        return;
      case "deepseek":
        await this.handleRoutingCommand(normalized, "deepseek");
        return;
      case "new":
        await this.handleNewCommand(normalized);
        return;
      case "reread":
        await this.handleRereadCommand(normalized);
        return;
      case "compact":
        await this.handleCompactCommand(normalized);
        return;
      case "switch":
        await this.handleSwitchCommand(normalized, command);
        return;
      case "stop":
        await this.handleStopCommand(normalized);
        return;
      case "checkin":
        await this.handleCheckinCommand(normalized, command);
        return;
      case "focus":
        await this.handleFocusCommand(normalized, command);
        return;
      case "chunk":
        await this.handleChunkCommand(normalized, command);
        return;
      case "yes":
      case "always":
      case "no":
        await this.handleApprovalCommand(normalized, command);
        return;
      case "model":
        await this.handleModelCommand(normalized, command);
        return;
      case "star":
        await this.handleStarCommand(normalized);
        return;
      case "help":
        await this.handleHelpCommand(normalized);
        return;
      case "review-status":
        await this.handleReviewStatusCommand(normalized, command);
        return;
      case "backfill":
        await this.handleBackfillCommand(normalized, command);
        return;
      default:
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: buildWeixinHelpText(),
          contextToken: normalized.contextToken,
        });
    }
  }

  async handleBindCommand(normalized, command) {
    const workspaceRoot = normalizeWorkspacePath(command.args);
    if (!workspaceRoot) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /bind /absolute/path",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ Only absolute paths are supported for /bind.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isPathWithinAllowedDirectories(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ The path must be within your home directory or the current working directory.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Workspace does not exist\n${workspaceRoot}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.runtimeAdapter.getSessionStore().setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Workspace bound\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStatusCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const context = threadState?.context?.runtimeId === runtimeName
      ? threadState.context
      : this.threadStateStore.getLatestContext(runtimeName);
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const storedModel = runtimeParams.model || "";
    const storedModelProvider = runtimeParams.modelProvider || this.runtimeAdapter.describe().modelProvider || "";
    const effectiveModel = this.runtimeAdapter.describe().model || storedModel;

    const lines = [
      `📍 workspace: ${workspaceRoot}`,
      `🧵 thread: ${threadId || "(none)"}`,
      `📊 status: ${threadState?.status || "idle"}`,
      `🤖 runtime: ${runtimeName}`,
      `🤖 model: ${effectiveModel || "(default)"}`,
      `🤖 provider: ${storedModelProvider || "(default)"}`,
    ];
    lines.push(formatContextStatusLine({
      runtimeName,
      context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    }));
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleUsageCommand(normalized) {
    const summary = this.usageStore.summarize();
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: formatUsageSummary(summary),
      contextToken: normalized.contextToken,
    });
  }

  async handleRoutingCommand(normalized, mode) {
    this.modelRouter.setNextMode(normalized.senderId, mode);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: mode === "codex"
        ? "下一条普通消息会交给 Codex。"
        : "下一条普通消息会交给 DeepSeek。",
      contextToken: normalized.contextToken,
    });
  }

  async handleNewCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({ bindingKey, workspaceRoot });
    }
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Switched to a fresh thread draft\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleRereadCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      await this.runtimeAdapter.refreshThreadInstructions({
        threadId,
        workspaceRoot,
        model: runtimeParams.model,
        modelProvider: runtimeParams.modelProvider,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Reread failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleCompactCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      await this.runtimeAdapter.compactThread({
        threadId,
        workspaceRoot,
        model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
      }).then((result) => {
        const compactTurnId = normalizeCommandArgument(result?.turnId);
        if (compactTurnId) {
          this.pendingOperationByRunKey.set(buildRunKey(threadId, compactTurnId), {
            kind: "compact",
            userId: normalized.senderId,
            contextToken: normalized.contextToken,
          });
        }
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `🗜️ Compact request sent\nthread: ${threadId}`,
        contextToken: normalized.contextToken,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Compact failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleSwitchCommand(normalized, command) {
    const targetThreadId = normalizeThreadId(command.args);
    if (!targetThreadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /switch <threadId>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const resumed = await this.runtimeAdapter.resumeThread({
      threadId: targetThreadId,
      workspaceRoot,
      model: runtimeParams.model,
      modelProvider: runtimeParams.modelProvider,
    });
    sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      resumed?.threadId || targetThreadId,
    );
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Thread switched\nworkspace: ${workspaceRoot}\nthread: ${resumed?.threadId || targetThreadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (!threadId || !threadState?.turnId || !["running", "waiting_approval"].includes(threadState.status)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no running thread right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    await this.runtimeAdapter.cancelTurn({
      threadId,
      turnId: threadState.turnId,
      workspaceRoot,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `⏹️ Stop request sent\nthread: ${threadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleCheckinCommand(normalized, command) {
    const rangeInput = normalizeCommandArgument(command.args);
    if (!rangeInput) {
      const currentRange = this.checkinConfigStore.getRange(resolveDefaultCheckinRange());
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⏰ Current check-in interval is ${Math.round(currentRange.minIntervalMs / 60000)}-${Math.round(currentRange.maxIntervalMs / 60000)} minutes.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const parsedRange = parseCheckinRangeMinutes(rangeInput);
    if (!parsedRange) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /checkin <min>-<max>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    this.checkinConfigStore.setRange({
      minIntervalMs: parsedRange.minMinutes * 60_000,
      maxIntervalMs: parsedRange.maxMinutes * 60_000,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Check-in interval reset to ${parsedRange.minMinutes}-${parsedRange.maxMinutes} minutes and will apply on the next polling cycle.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleFocusCommand(normalized, command) {
    const result = await this.projectServices?.focusProtection?.startFromCommand?.(command.args, normalized);
    let text = result?.reply || "";
    if (result?.cancelled) {
      text = "好，Focus 先取消。你不用补解释，等会儿我们从现在重新接。";
    }
    if (!text) {
      text = result?.error || "💡 Usage: /focus 25 Englisch · /focus until 18:00 Deutsch · /focus cancel";
    }
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
    });
  }

  async handleChunkCommand(normalized, command) {
    const arg = normalizeCommandArgument(command.args);
    if (!arg) {
      const current = this.channelAdapter.getMinChunkChars?.() ?? DEFAULT_MIN_WEIXIN_CHUNK;
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `💡 Current minimum merge chunk is ${current} characters. Usage: /chunk <number> (e.g. /chunk 50)`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const parsed = Number.parseInt(arg, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_MIN_WEIXIN_CHUNK) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️  Invalid value. Please provide a number between 1 and ${MAX_MIN_WEIXIN_CHUNK}.`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const updated = this.channelAdapter.setMinChunkChars?.(parsed) ?? parsed;
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Minimum merge chunk set to ${updated} characters. Shorter fragments will be merged into one message up to this size.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleApprovalCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const approval = threadState?.pendingApproval || null;
    if (!threadId || approval?.requestId == null || String(approval.requestId).trim() === "") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no pending approval request right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ This Codex MCP request cannot be answered from WeChat yet.",
        contextToken: normalized.contextToken,
      });
      return;
    }
    console.log(
      `[cyberboss] approval response requested thread=${threadId} requestId=${approval.requestId} mode=${approvalResponse.result ? "result" : "decision"} workspace=${workspaceRoot}`
    );
    await this.runtimeAdapter.respondApproval(approvalResponse);
    this.runtimeAdapter.getSessionStore().clearApprovalPrompt(threadId);
    console.log(
      `[cyberboss] approval response delivered thread=${threadId} requestId=${approval.requestId}`
    );
    if (command.name === "always" && isApprovalAcceptResponse(approvalResponse)) {
      this.runtimeAdapter.getSessionStore().rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
    }
    this.threadStateStore.resolveApproval(threadId, "running");
    const text = buildApprovalResponseText(approval, command.name, approvalResponse);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
    });
  }

  async handleModelCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const query = normalizeCommandArgument(command.args);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const catalog = sessionStore.getAvailableModelCatalog();
    const currentModel = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;

    if (!query) {
      const lines = [
        `Current model: ${currentModel || "(default)"}`,
      ];
      if (catalog?.models?.length) {
        lines.push(`Available models: ${catalog.models.map((item) => item.model).join(", ")}`);
      } else {
        lines.push("Available models: (not available)");
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: lines.join("\n"),
        contextToken: normalized.contextToken,
      });
      return;
    }

    const runtimeId = this.runtimeAdapter.describe().id || "runtime";
    let matched = findModelByQuery(catalog?.models || [], query);
    if (!matched && runtimeId !== "codex" && !catalog?.models?.length) {
      matched = { model: query };
    }
    if (!matched) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Model not found\n${query}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: matched.model,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Model switched\nworkspace: ${workspaceRoot}\nmodel: ${matched.model}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStarCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        "⭐️ Liked this project? Throw me a star on GitHub!",
        "It really means a lot to an indie dev working on passion projects 💖",
        "",
        "https://github.com/WenXiaoWendy/cyberboss",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
    await this.channelAdapter.sendFile({
      userId: normalized.senderId,
      filePath: path.join(__dirname, "../../assets/star-guide.jpg"),
      contextToken: normalized.contextToken,
    }).catch(() => {});
  }

  async handleHelpCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: buildWeixinHelpText(),
      contextToken: normalized.contextToken,
    });
  }

  async handleReviewStatusCommand(normalized, command) {
    const date = normalizeCommandArgument(command.args).split(/\s+/)[0];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /review-status YYYY-MM-DD\nExample: /review-status 2026-06-08",
        contextToken: normalized.contextToken,
      });
      return;
    }
    const result = checkReviewStatus({
      stateDir: this.config.stateDir,
      obsidianDailyNoteDir: this.config.obsidianDailyNoteDir,
      date,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: formatStatusReport(result),
      contextToken: normalized.contextToken,
    });
  }

  async handleBackfillCommand(normalized, command) {
    const rawArgs = normalizeCommandArgument(command.args).split(/\s+/);
    const date = rawArgs.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
    const force = rawArgs.includes("--force");

    if (!date) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /backfill YYYY-MM-DD [--force]\nExample: /backfill 2026-06-08",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const result = checkReviewStatus({
      stateDir: this.config.stateDir,
      obsidianDailyNoteDir: this.config.obsidianDailyNoteDir,
      date,
    });

    if (result.obsidian.hasReviewContent && !force) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Daily Review for ${date} appears complete.\nUse /backfill ${date} --force to regenerate.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!result.inbox.found) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ No Daily Inbox found for ${date}. Cannot backfill without source data.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);

    this.systemMessageQueue.enqueue({
      id: crypto.randomUUID(),
      accountId: normalized.accountId,
      senderId: normalized.senderId,
      workspaceRoot,
      text: buildBackfillSystemMessage(date),
      createdAt: new Date().toISOString(),
    });

    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        `✅ Backfill queued for ${date}`,
        "",
        formatStatusReport(result),
        "",
        "⚠️ 注意：此任务需要主 runtime（Codex）才能执行。",
        "如果 Codex 当前不可用，DeepSeek fallback 无法写入 Obsidian，会保持 silent 等待主模型恢复。",
        "如需立即补跑，请从终端运行 npm run backfill 后用 Claude Code 直接生成。",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  resolveWorkspaceRoot(bindingKey) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    return sessionStore.getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async handleRuntimeEvent(event) {
    if (event?.type === "runtime.context.updated") {
      this.usageStore.recordRuntimeContext(event.payload);
      const primaryUsedPercent = Number(event?.payload?.rateLimits?.primaryUsedPercent || 0);
      if (primaryUsedPercent >= 100) {
        console.warn(
          `[cyberboss] runtime rate limit saturated runtime=${event?.payload?.runtimeId || ""} thread=${event?.payload?.threadId || ""} primaryUsedPercent=${primaryUsedPercent}`
        );
      }
    }
    const failureReplyTarget = event?.type === "runtime.turn.failed"
      ? this.streamDelivery.resolveReplyTargetForRun({
          threadId: event?.payload?.threadId,
          turnId: event?.payload?.turnId,
        })
      : null;
    const fallbackContext = event?.type === "runtime.turn.failed"
      ? this.getFallbackContext(event?.payload?.threadId, event?.payload?.turnId)
      : null;
    const activeFallbackContext = this.getFallbackContext(event?.payload?.threadId, event?.payload?.turnId);
    if (event?.type === "runtime.reply.delta" || event?.type === "runtime.reply.completed") {
      this.markFallbackResponseStarted(activeFallbackContext);
    }
    const suppressLateReply = activeFallbackContext?.fallbackSent
      && (event?.type === "runtime.reply.delta" || event?.type === "runtime.reply.completed");
    if (!suppressLateReply) {
      await this.streamDelivery.handleRuntimeEvent(event);
    }
    if (!event) {
      return;
    }
    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      if (event.type === "runtime.turn.failed") {
        console.error(
          `[cyberboss] runtime turn failed thread=${event?.payload?.threadId || ""} turn=${event?.payload?.turnId || ""} error=${event?.payload?.text || "unknown"}`
        );
      }
      const completedRunKey = buildRunKey(event.payload.threadId, event.payload.turnId);
      const pendingOperations = this.pendingOperationByRunKey;
      const pendingOperation = pendingOperations?.get?.(completedRunKey) || null;
      if (pendingOperation && pendingOperations?.delete) {
        pendingOperations.delete(completedRunKey);
      }
      const sessionStore = this.runtimeAdapter.getSessionStore();
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(event.payload.threadId);
      const scopeKey = linked?.bindingKey && linked?.workspaceRoot
        ? buildScopeKey(linked.bindingKey, linked.workspaceRoot)
        : "";
      if (scopeKey) {
        this.turnBoundaryScopeKeys.add(scopeKey);
      }
      try {
        this.turnGateStore.releaseThread(event.payload.threadId);
        if (event.type === "runtime.turn.failed") {
          const fallbackSent = await this.sendDeepSeekFallback({
            ...fallbackContext,
            reason: event.payload.text || "Runtime turn failed",
            replyTarget: failureReplyTarget || fallbackContext?.replyTarget,
          });
          if (!fallbackSent) {
            await this.sendFailureToThread(
              event.payload.threadId,
              event.payload.text || "❌ Execution failed",
              failureReplyTarget,
            );
          }
        }
        if (linked?.bindingKey && linked?.workspaceRoot) {
          await this.flushPendingInboundMessages({
            bindingKey: linked.bindingKey,
            workspaceRoot: linked.workspaceRoot,
            ignoreBoundary: true,
          });
        } else {
          await this.flushPendingInboundMessages();
        }
        await this.flushPendingSystemMessages();
        if (pendingOperation?.kind === "compact" && event.type === "runtime.turn.completed") {
          await this.channelAdapter.sendText({
            userId: pendingOperation.userId,
            text: `✅ Compact finished\nthread: ${event.payload.threadId}`,
            contextToken: pendingOperation.contextToken,
          }).catch(() => {});
        }
        const shouldKeepTyping = linked?.bindingKey && linked?.workspaceRoot
          ? (
            this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot)
            || this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)
          )
          : false;
        if (!shouldKeepTyping) {
          await this.stopTypingForThread(event.payload.threadId);
        }
      } finally {
        this.forgetFallbackContext(event.payload.threadId, event.payload.turnId);
        if (scopeKey) {
          this.turnBoundaryScopeKeys.delete(scopeKey);
        }
      }
      return;
    }
    if (event.type !== "runtime.approval.requested") {
      return;
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const linked = sessionStore.findBindingForThreadId(event.payload.threadId);
    if (!linked?.workspaceRoot) {
      return;
    }
    const allowlist = sessionStore.getApprovalCommandAllowlistForWorkspace(linked.workspaceRoot);
    const shouldAutoApprove = isAutoApprovedStateDirOperation(event.payload, this.config)
      || matchesBuiltInCommandPrefix(event.payload.commandTokens)
      || matchesCommandPrefix(event.payload.commandTokens, allowlist);
    if (!shouldAutoApprove) {
      const promptState = sessionStore.getApprovalPromptState(event.payload.threadId);
      const promptSignature = buildApprovalPromptSignature(event.payload);
      if (promptState?.signature && promptState.signature === promptSignature) {
        sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
        console.log(
          `[cyberboss] approval prompt deduped thread=${event.payload.threadId} requestId=${event.payload.requestId}`
        );
        return;
      }
      sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch((error) => {
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        throw error;
      });
      return;
    }
    const approvalResponse = buildApprovalResponsePayload(event.payload, "yes");
    if (!approvalResponse) {
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch(() => {});
      return;
    }
    await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
    this.threadStateStore.resolveApproval(event.payload.threadId, "running");
  }

  async stopTypingForThread(threadId) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null;
    if (!target) {
      return;
    }
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  async sendFailureToThread(threadId, text, fallbackTarget = null) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = normalizeReplyTarget(
      linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null
    ) || normalizeReplyTarget(fallbackTarget);
    if (!target) {
      return;
    }
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: normalizeText(text) || "❌ Execution failed",
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  rememberFallbackContext({ threadId = "", turnId = "", text = "", provider = "", replyTarget = null } = {}) {
    const runKey = buildRunKey(threadId, turnId);
    if (!threadId || !runKey) {
      return;
    }
    const context = {
      threadId,
      turnId,
      text: normalizeText(text),
      provider: normalizeText(provider),
      replyTarget: normalizeReplyTarget(replyTarget),
      fallbackSent: false,
      responseStarted: false,
      timer: null,
    };
    const fallbackAfterMs = Number(this.config.deepseekFallbackAfterMs) || 0;
    if (fallbackAfterMs > 0 && this.deepseekFallback?.isEnabled()) {
      context.timer = setTimeout(() => {
        void this.handleFallbackTimeout(context);
      }, fallbackAfterMs);
      context.timer.unref?.();
    }
    this.fallbackContextByRunKey.set(runKey, context);
  }

  getFallbackContext(threadId = "", turnId = "") {
    return this.fallbackContextByRunKey.get(buildRunKey(threadId, turnId)) || null;
  }

  forgetFallbackContext(threadId = "", turnId = "") {
    const runKey = buildRunKey(threadId, turnId);
    const context = this.fallbackContextByRunKey.get(runKey);
    if (context?.timer) {
      clearTimeout(context.timer);
    }
    this.fallbackContextByRunKey.delete(runKey);
  }

  async handleEmptyModelReply({ threadId = "", turnId = "", replyTarget = null } = {}) {
    const context = this.getFallbackContext(threadId, turnId);
    if (context?.fallbackSent) {
      return true;
    }
    const target = normalizeReplyTarget(replyTarget || context?.replyTarget);
    if (target?.provider === "system" && !systemTriggerRequiresDelivery(context?.text)) {
      console.log(`[cyberboss] empty system reply treated as silent thread=${threadId}`);
      return true;
    }
    return this.sendDeepSeekFallback({
      ...context,
      reason: "Codex completed without a usable reply",
      replyTarget: replyTarget || context?.replyTarget,
    });
  }

  async sendDeepSeekFallback({ text = "", reason = "", provider = "", replyTarget = null, fallbackSent = false } = {}) {
    if (fallbackSent) {
      return true;
    }
    const target = normalizeReplyTarget(replyTarget);
    if (!target || !this.deepseekFallback?.isEnabled()) {
      return false;
    }
    try {
      const result = await this.deepseekFallback.generate({
        userText: text,
        reason,
        provider,
        systemMessage: provider === "system",
      });
      if (!result.used || !result.text) {
        return false;
      }
      this.recordDeepSeekUsage(`fallback:${target.userId}`, result.usage);
      if (provider === "system") {
        const action = parseFallbackSystemAction(result.text);
        if (action.action === "silent") {
          console.log(`[cyberboss] deepseek fallback silent model=${result.model || ""}`);
          return true;
        }
        if (action.action !== "send_message" || !action.message) {
          return false;
        }
        await this.channelAdapter.sendText({
          userId: target.userId,
          text: action.message,
          contextToken: target.contextToken,
        });
      } else {
        await this.channelAdapter.sendText({
          userId: target.userId,
          text: result.text,
          contextToken: target.contextToken,
        });
      }
      console.warn(
        `[cyberboss] deepseek fallback sent model=${result.model || ""} reason=${normalizeText(reason).slice(0, 120)}`
      );
      return true;
    } catch (error) {
      console.error(`[cyberboss] deepseek fallback failed: ${formatErrorMessage(error)}`);
      return false;
    }
  }

  async dispatchDeepSeekDailyReply({ prepared, routing } = {}) {
    if (!prepared?.senderId || !prepared?.contextToken || !this.deepseekFallback?.isEnabled()) {
      return false;
    }
    const text = normalizeText(prepared.originalText || prepared.text);
    if (!text) {
      return false;
    }
    await this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
    try {
      const history = this.deepseekConversationBySender.get(prepared.senderId) || [];
      const result = await this.deepseekFallback.generate({
        userText: text,
        provider: prepared.provider,
        mode: "daily",
        history,
        context: await this.buildDeepSeekDailyContext(prepared),
      });
      if (!result.used || !result.text) {
        return false;
      }
      await this.channelAdapter.sendText({
        userId: prepared.senderId,
        text: result.text,
        contextToken: prepared.contextToken,
      });
      this.recordDeepSeekUsage(prepared.senderId, result.usage);
      this.rememberDeepSeekConversation(prepared.senderId, text, result.text);
      console.log(
        `[cyberboss] deepseek daily reply sent model=${result.model || ""} reason=${routing?.reason || ""}`
      );
      return true;
    } catch (error) {
      console.error(`[cyberboss] deepseek daily reply failed: ${formatErrorMessage(error)}`);
      return false;
    }
  }

  recordDeepSeekUsage(senderId, usage) {
    this.usageStore.recordRuntimeContext({
      runtimeId: "deepseek",
      threadId: senderId,
      turnId: crypto.randomUUID(),
      turnUsage: usage,
    });
  }

  rememberDeepSeekConversation(senderId, userText, assistantText) {
    const history = this.deepseekConversationBySender.get(senderId) || [];
    history.push(
      { role: "user", content: userText },
      { role: "assistant", content: assistantText },
    );
    this.deepseekConversationBySender.set(senderId, history.slice(-12));
  }

  async buildDeepSeekDailyContext(prepared = null) {
    const priority = this.projectServices?.priorityAwareness?.status?.() || null;
    const lines = [];
    if (priority?.priorities?.length) {
      const completed = priority.priorities.filter((item) => item.status === "completed").map((item) => item.label);
      const open = priority.priorities.filter((item) => item.status === "pending" || item.status === "unknown").map((item) => item.label);
      lines.push(
        `Today's explicit priority boundary: ${priority.deadlineLabel || "unknown"} ${priority.deadlineAt || ""}`.trim(),
        `Completed priorities: ${completed.length ? completed.join(", ") : "none recorded"}`,
        `Open priorities: ${open.length ? open.join(", ") : "none"}`,
        "Do not command or invent an order. If the user's message changes this state, acknowledge it while gently preserving awareness of remaining priorities when useful.",
      );
    }
    if (prepared) {
      const temporal = await this.buildRuntimeTemporalContext(prepared);
      if (temporal) {
        if (lines.length) lines.push("");
        lines.push("Temporal context:", temporal);
      }
    }
    return lines.join("\n");
  }

  markFallbackResponseStarted(context) {
    if (!context) {
      return;
    }
    context.responseStarted = true;
    if (context.timer) {
      clearTimeout(context.timer);
      context.timer = null;
    }
  }

  async handleFallbackTimeout(context) {
    if (!context || context.responseStarted || context.fallbackSent) {
      return;
    }
    const sent = await this.sendDeepSeekFallback({
      ...context,
      reason: "Codex did not begin a reply before the fallback timeout",
    });
    if (!sent) {
      return;
    }
    context.fallbackSent = true;
    console.warn(`[cyberboss] deepseek fallback timeout thread=${context.threadId} turn=${context.turnId}`);
    await this.runtimeAdapter.cancelTurn({
      threadId: context.threadId,
      turnId: context.turnId,
    }).catch(() => {});
  }

  async sendApprovalPrompt({ bindingKey, approval }) {
    const target = this.resolveReplyTargetForBinding(bindingKey);
    if (!target) {
      console.warn(
        `[cyberboss] approval prompt skipped binding=${bindingKey} requestId=${approval?.requestId || ""} reason=no_reply_target`
      );
      return;
    }
    console.log(
      `[cyberboss] approval prompt sending binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: buildApprovalPromptText(approval),
      contextToken: target.contextToken,
      preserveBlock: true,
    });
    console.log(
      `[cyberboss] approval prompt delivered binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
  }

  async restoreBoundThreadSubscriptions() {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const bindings = sessionStore.listBindings();
    const seenThreadIds = new Set();

    for (const binding of bindings) {
      const bindingKey = normalizeText(binding?.bindingKey);
      if (!bindingKey) {
        continue;
      }

      const target = this.resolveReplyTargetForBinding(bindingKey);
      if (target) {
        this.streamDelivery.setReplyTarget(bindingKey, target);
      }

      for (const workspaceRoot of sessionStore.listWorkspaceRoots(bindingKey)) {
        const normalizedWorkspaceRoot = normalizeCommandArgument(workspaceRoot);
        const normalizedThreadId = normalizeCommandArgument(
          sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot)
        );
        if (!normalizedThreadId || seenThreadIds.has(normalizedThreadId)) {
          continue;
        }
        seenThreadIds.add(normalizedThreadId);
        await this.runtimeAdapter.resumeThread({
          threadId: normalizedThreadId,
          workspaceRoot: normalizedWorkspaceRoot,
        }).catch(() => {});
      }
    }
  }

  resolveReplyTargetForBinding(bindingKey) {
    const binding = this.runtimeAdapter.getSessionStore().getBinding(bindingKey) || null;
    const userId = normalizeCommandArgument(binding?.senderId);
    if (!userId) {
      return null;
    }
    const contextToken = this.channelAdapter.getKnownContextTokens()[userId] || "";
    if (!contextToken) {
      return null;
    }
    return {
      userId,
      contextToken,
      provider: this.channelAdapter.describe().id,
    };
  }
}

function buildRunKey(threadId, turnId) {
  return `${normalizeCommandArgument(threadId)}:${normalizeCommandArgument(turnId)}`;
}

function normalizeReplyTarget(target) {
  if (!target?.userId || !target?.contextToken) {
    return null;
  }
  return {
    userId: String(target.userId).trim(),
    contextToken: String(target.contextToken).trim(),
    provider: normalizeText(target.provider),
  };
}

function formatHourText(hour) {
  if (hour === null || hour === undefined || !Number.isFinite(Number(hour))) {
    return "unknown";
  }
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60);
  return `${String(whole).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function systemTriggerRequiresDelivery(preparedText = "") {
  const text = String(preparedText || "");
  const triggerMarker = "\nTrigger:\n";
  const triggerIndex = text.indexOf(triggerMarker);
  const trigger = triggerIndex >= 0 ? text.slice(triggerIndex + triggerMarker.length) : "";
  if (!trigger || /no_deepseek_fallback=true/i.test(trigger)) {
    return false;
  }
  return trigger.includes("DELIVERY REQUIRED");
}

function formatCompactNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "0";
  }
  if (normalized >= 1_000_000) {
    return `${Math.round(normalized / 100_000) / 10}m`;
  }
  if (normalized >= 1_000) {
    return `${Math.round(normalized / 100) / 10}k`;
  }
  return String(Math.round(normalized));
}

function formatContextStatusLine({ runtimeName, context, claudeContextWindow, claudeMaxOutputTokens }) {
  if (runtimeName === "claudecode") {
    const configuredWindow = Number(claudeContextWindow);
    if (!Number.isFinite(configuredWindow) || configuredWindow <= 0) {
      return "📦 context: set CYBERBOSS_CLAUDE_CONTEXT_WINDOW";
    }
    const reservedOutputTokens = Math.max(0, Number(claudeMaxOutputTokens) || 0);
    const availableMessageWindow = configuredWindow - reservedOutputTokens;
    if (availableMessageWindow <= 0) {
      return "📦 context: reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS";
    }
    if (!context || !Number.isFinite(Number(context.currentTokens))) {
      return "📦 context: unavailable";
    }
    const summary = formatContextUsage(Number(context.currentTokens), availableMessageWindow);
    if (reservedOutputTokens > 0) {
      return `📦 context: approx ${summary} | reserve ${formatCompactNumber(reservedOutputTokens)}`;
    }
    return `📦 context: approx ${summary}`;
  }
  if (!context) {
    return "📦 context: unavailable";
  }
  const currentTokens = Number(context.currentTokens);
  const contextWindow = Number(context.contextWindow);
  if (!Number.isFinite(currentTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return "📦 context: unavailable";
  }
  return `📦 context: ${formatContextUsage(currentTokens, contextWindow)}`;
}

function formatContextUsage(currentTokens, contextWindow) {
  const safeCurrent = Math.max(0, Number(currentTokens) || 0);
  const safeWindow = Math.max(1, Number(contextWindow) || 1);
  const clampedCurrent = Math.min(safeCurrent, safeWindow);
  const leftPercent = Math.max(0, Math.min(100, Math.round(((safeWindow - clampedCurrent) / safeWindow) * 100)));
  return `${formatCompactNumber(clampedCurrent)}/${formatCompactNumber(safeWindow)} | ${leftPercent}% left`;
}

function formatUsageSummary(summary = {}) {
  const pricing = summary.pricing || {};
  const lines = [
    "💸 Usage",
    `timezone: ${summary.timeZone || "UTC"}`,
    "",
  ];
  if (!summary.hasRecordedUsage) {
    lines.push(
      "No token usage has been recorded yet.",
      "This does not mean the model used 0 tokens.",
      "",
    );
  }
  lines.push(
    formatUsageLine("today", summary.today, summary.todayCostUsd),
    formatUsageLine("this week", summary.week, summary.weekCostUsd),
    formatUsageLine("this month", summary.month, summary.monthCostUsd),
  );
  const runtimeEntries = Object.entries(summary.byRuntime || {}).sort(([left], [right]) => left.localeCompare(right));
  if (runtimeEntries.length) {
    lines.push("", "by runtime:");
    for (const [runtimeId, runtime] of runtimeEntries) {
      lines.push(
        `  ${runtimeId}: today ${formatCompactNumber(runtime.today?.totalTokens || 0)} · week ${formatCompactNumber(runtime.week?.totalTokens || 0)} · month ${formatCompactNumber(runtime.month?.totalTokens || 0)} tokens`
      );
    }
  }
  lines.push("", `estimate: ${formatPricingSummary(pricing)}`);
  return lines.join("\n");
}

function buildAutoDiaryCaptureText(normalized = {}, config = {}) {
  const provider = normalizeText(normalized.provider) || "channel";
  const receivedAt = formatConfiguredLocalDateTime(normalized.receivedAt, config.diaryTimeZone || config.timeZone);
  const text = normalizeText(normalized.text);
  const lines = [
    `- 来源：${provider}`,
  ];
  if (receivedAt) {
    lines.push(`- 接收时间：${receivedAt}`);
  }
  lines.push("- 内容：");
  lines.push(...quoteMarkdown(text));
  return lines.join("\n");
}

function resolveCaptureLocalDateTime(receivedAt, config = {}) {
  const timeZone = normalizeText(config.diaryTimeZone) || normalizeText(config.timeZone) || "UTC";
  const date = parseDateOrNow(receivedAt);
  return {
    date: formatDatePart(date, timeZone),
    time: formatTimePart(date, timeZone),
  };
}

function formatConfiguredLocalDateTime(receivedAt, timeZone = "") {
  const zone = normalizeText(timeZone) || process.env.CYBERBOSS_DIARY_TIME_ZONE || process.env.CYBERBOSS_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const value = normalizeText(receivedAt);
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${formatDatePart(date, zone)} ${formatTimePart(date, zone)}`;
}

function formatTemporalCalendarEvent(event = {}) {
  const title = normalizeText(event.title) || "(untitled)";
  const start = normalizeText(event.start) || "??:??";
  const end = normalizeText(event.end) || "??:??";
  const calendar = normalizeText(event.calendar);
  return `${start}-${end} ${title}${calendar ? ` [${calendar}]` : ""}`;
}

function addDaysDateText(dateText, days) {
  const parsed = new Date(`${normalizeText(dateText)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return normalizeText(dateText);
  }
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function parseDateOrNow(value) {
  const parsed = new Date(normalizeText(value));
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatDatePart(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTimePart(date, timeZone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function quoteMarkdown(text) {
  const lines = normalizeText(text).split(/\r?\n/);
  return lines.length ? lines.map((line) => `  > ${line}`) : ["  >"];
}

function formatUsageLine(label, usage = {}, costUsd = 0) {
  const total = Number(usage.totalTokens) || 0;
  const input = Number(usage.inputTokens) || 0;
  const cached = Number(usage.cachedInputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const reasoning = Number(usage.reasoningTokens) || 0;
  const details = [
    `in ${formatCompactNumber(input)}`,
    `cached ${formatCompactNumber(cached)}`,
    `out ${formatCompactNumber(output)}`,
    `reasoning ${formatCompactNumber(reasoning)}`,
  ].join(" · ");
  return `${label}: ${formatCompactNumber(total)} tokens | ${formatUsd(costUsd)}\n  ${details}`;
}

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "$0.00";
  }
  if (amount < 0.01) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

function formatPricingSummary(pricing = {}) {
  const input = Number(pricing.inputUsdPer1M) || 0;
  const cached = Number(pricing.cachedInputUsdPer1M) || 0;
  const output = Number(pricing.outputUsdPer1M) || 0;
  const reasoning = Number(pricing.reasoningUsdPer1M) || 0;
  if (input || cached || output || reasoning) {
    return `configured itemized USD/1M tokens`;
  }
  return `$${(Number(pricing.blendedUsdPer1M) || 2).toFixed(2)}/1M blended tokens`;
}

function buildLocationMovementSystemText(event) {
  const distanceText = `${formatCompactNumber(event?.distanceMeters || 0)}m`;
  const fromLabel = normalizeText(event?.fromAddress) || formatLatLng(event?.fromCenterLat, event?.fromCenterLng);
  const toLabel = normalizeText(event?.toAddress) || formatLatLng(event?.toCenterLat, event?.toCenterLng);
  const movedAt = normalizeText(event?.movedAt) || new Date().toISOString();
  return [
    "System context: the user's location appears to have changed significantly.",
    `Distance: about ${distanceText}.`,
    fromLabel ? `From: ${fromLabel}` : "",
    toLabel ? `To: ${toLabel}` : "",
    `Observed at: ${movedAt}.`,
  ].filter(Boolean).join("\n");
}

function buildLocationTriggerSystemText(trigger) {
  switch (normalizeText(trigger)) {
    case "arrive_home":
      return "User arrives home.";
    case "leave_home":
      return "User leaves home.";
    default:
      return "";
  }
}

function formatLatLng(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "";
  }
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
function createShutdownController(onStop) {
  let stopped = false;
  let stoppingPromise = null;

  const stop = async () => {
    if (stopped) {
      return stoppingPromise;
    }
    stopped = true;
    stoppingPromise = Promise.resolve().then(onStop);
    return stoppingPromise;
  };

  const handleSignal = () => {
    stop().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return {
    get stopped() {
      return stopped;
    },
    dispose() {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    },
  };
}

function assertChannelUpdateResponse(response, channelId = "channel") {
  const ret = normalizeErrorCode(response?.ret);
  const errcode = normalizeErrorCode(response?.errcode);
  if ((ret !== 0 && ret !== null) || (errcode !== 0 && errcode !== null)) {
    const error = new Error(
      `${channelId} getUpdates ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${normalizeText(response?.errmsg) || ""}`
    );
    error.ret = ret;
    error.errcode = errcode;
    throw error;
  }
}

function isSessionExpiredError(error) {
  const ret = normalizeErrorCode(error?.ret);
  const errcode = normalizeErrorCode(error?.errcode);
  return ret === SESSION_EXPIRED_ERRCODE
    || errcode === SESSION_EXPIRED_ERRCODE
    || String(error?.message || "").includes("session expired")
    || String(error?.message || "").includes("session invalidated");
}

function normalizeErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || "unknown error");
  if (isSessionExpiredError(error)) {
    return "The WeChat session has expired. Run `npm run login` again.";
  }
  return raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { CyberbossApp };

function parseChannelCommand(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized.startsWith("/")) {
    return null;
  }
  const [rawName, ...rest] = normalized.slice(1).split(/\s+/);
  const name = normalizeCommandName(rawName);
  if (!name) {
    return null;
  }
  return {
    name,
    args: rest.join(" ").trim(),
  };
}

function normalizeCommandName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;
const WINDOWS_UNC_PREFIX_RE = /^\/\/\?\//;

function normalizeWorkspacePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const fromFileUri = extractPathFromFileUri(normalized);
  const rawPath = fromFileUri || normalized;
  const withForwardSlashes = rawPath.replace(/\\/g, "/").replace(WINDOWS_UNC_PREFIX_RE, "");
  const normalizedDrivePrefix = /^\/[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes.slice(1)
    : withForwardSlashes;

  if (WINDOWS_DRIVE_ROOT_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.replace(/\/+$/g, "");
  }
  return normalizedDrivePrefix.replace(/\/+$/g, "");
}

function isAbsoluteWorkspacePath(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) {
    return false;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    return true;
  }
  return path.posix.isAbsolute(normalized);
}

function extractPathFromFileUri(value) {
  const input = String(value || "").trim();
  if (!/^file:\/\//i.test(input)) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return "";
    }
    const pathname = decodeURIComponent(parsed.pathname || "");
    const withHost = parsed.host && parsed.host !== "localhost"
      ? `//${parsed.host}${pathname}`
      : pathname;
    return withHost;
  } catch {
    return "";
  }
}

function isPathWithinAllowedDirectories(rawPath) {
  const resolved = path.resolve(rawPath);
  const normalized = resolved.replace(/\\/g, "/") + "/";
  const allowedDirs = [
    os.homedir(),
    process.cwd(),
    this?.config?.workspaceRoot,
  ]
    .filter(Boolean)
    .map((dir) => path.resolve(dir).replace(/\\/g, "/") + "/");
  return allowedDirs.some((prefix) => normalized.startsWith(prefix));
}

function normalizeCommandArgument(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThreadId(value) {
  const normalized = normalizeCommandArgument(value);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\s+/g, "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function matchesBuiltInCommandPrefix(commandTokens) {
  const normalized = normalizeCommandTokensForMatching(commandTokens);
  if (!normalized.length) {
    return false;
  }

  if (normalized[0] === "view_image") {
    return true;
  }

   if (normalized[0] === "mcp_tool" && normalized[1] === "cyberboss_tools") {
    return true;
  }

  return false;
}

function normalizeCommandTokensForMatching(commandTokens) {
  return canonicalizeCommandTokens(commandTokens);
}

function buildApprovalPromptText(approval) {
  if (approval?.kind === "mcp_elicitation") {
    return buildElicitationApprovalPromptText(approval);
  }
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const toolName = extractToolNameFromReason(reasonText) || "";
  const commandLines = commandText ? commandText.split("\n") : [];
  const firstCommandLine = normalizeText(commandLines[0]);
  const restCommandLines = commandLines.slice(1);
  const shouldShowReason = reasonText && normalizeText(reasonText) !== normalizeText(`Tool: ${firstCommandLine}`);

  const out = [];
  out.push(`🔐 【Approval】${toolName || "Tool request"}`);

  if (shouldShowReason) {
    out.push(`📋 ${reasonText}`);
  }

  if (commandText) {
    if (firstCommandLine) {
      out.push(`⌨️ ${firstCommandLine}`);
    }
    if (restCommandLines.length) {
      out.push(restCommandLines.map((line) => `  ${line}`).join("\n"));
    }
  }

  if (!reasonText && !commandText) {
    out.push("❓ (unknown)");
  }

  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  out.push("👉 /yes    allow once");
  out.push("👉 /always auto-allow");
  out.push("👉 /no     deny");

  return out.join("\n");
}

function extractToolNameFromReason(reason) {
  const normalized = normalizeText(reason);
  if (!normalized) return "";
  if (normalized.toLowerCase().startsWith("tool:")) {
    return normalized.slice(5).trim();
  }
  return normalized;
}

function buildApprovalPromptSignature(approval) {
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const commandTokens = Array.isArray(approval?.commandTokens)
    ? approval.commandTokens.map((token) => normalizeCommandArgument(token)).filter(Boolean)
    : [];
  return JSON.stringify({
    kind: normalizeText(approval?.kind),
    reason: reasonText,
    command: commandText,
    commandTokens,
    responseTemplate: approval?.responseTemplate || null,
  });
}

function buildApprovalResponsePayload(approval, commandName) {
  const requestId = approval?.requestId;
  if (requestId == null || String(requestId).trim() === "") {
    return null;
  }
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    const responseByCommand = approval?.responseTemplate?.responseByCommand;
    const effectiveCommandName = commandName === "always" ? "yes" : commandName;
    const result = responseByCommand && typeof responseByCommand === "object"
      ? (responseByCommand[commandName] || responseByCommand[effectiveCommandName])
      : null;
    if (!result || typeof result !== "object") {
      return null;
    }
    return { requestId, result };
  }
  const decision = commandName === "no" ? "decline" : "accept";
  return { requestId, decision };
}

function buildApprovalResponseText(approval, commandName, approvalResponse) {
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    if (commandName === "always" && isApprovalAcceptResponse(approvalResponse)) {
      return "💡 Auto-approve enabled for this MCP tool in the current workspace.";
    }
    if (commandName === "yes") {
      return "✅ This request has been approved.";
    }
    return "❌ This request has been cancelled.";
  }
  return commandName === "always"
    ? "💡 Auto-approve enabled for this command prefix in the current workspace."
    : (commandName === "yes" ? "✅ This request has been approved." : "❌ This request has been denied.");
}

function isApprovalAcceptResponse(approvalResponse) {
  if (!approvalResponse || typeof approvalResponse !== "object") {
    return false;
  }
  if (approvalResponse.decision === "accept") {
    return true;
  }
  return normalizeText(approvalResponse.result?.action) === "accept";
}

function buildElicitationApprovalPromptText(approval) {
  const elicitation = approval?.elicitation || {};
  const messageText = normalizeText(elicitation?.message);
  const commandText = normalizeText(approval?.command);
  const approvalKind = normalizeText(elicitation?.approvalKind);
  const out = [];
  out.push(`🔐 【Approval】${normalizeText(approval?.reason) || "MCP request"}`);
  if (messageText) {
    out.push(`📋 ${messageText.split("\n")[0]}`);
  }
  if (commandText) {
    const commandLines = commandText.split("\n").map((line) => normalizeText(line)).filter(Boolean);
    if (commandLines.length) {
      out.push(`⌨️ ${commandLines[0]}`);
      if (commandLines.length > 1) {
        out.push(commandLines.slice(1).map((line) => `  ${line}`).join("\n"));
      }
    }
  }

  const toolDescription = normalizeText(elicitation?.toolDescription);
  if (toolDescription && approvalKind === "mcp_tool_call") {
    out.push("━━━━━━━━━━━━━");
    out.push(`🧾 ${toolDescription}`);
  }

  const supportedCommands = new Set(
    Array.isArray(approval?.responseTemplate?.supportedCommands)
      ? approval.responseTemplate.supportedCommands
      : []
  );
  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  if (supportedCommands.has("yes")) {
    out.push("👉 /yes    allow once");
  }
  if (supportedCommands.has("always") || (supportedCommands.has("yes") && approval?.kind === "mcp_tool_call")) {
    out.push("👉 /always auto-allow");
  }
  if (supportedCommands.has("no")) {
    out.push("👉 /no     cancel this request");
  }
  if (!supportedCommands.size) {
    out.push("⚠️ This Codex MCP request cannot be answered from WeChat yet.");
  }

  return out.join("\n");
}

function buildReminderSystemTrigger(reminder, config = {}) {
  const reminderText = String(reminder?.text || "").trim();
  if (reminderText.startsWith(FOCUS_REMINDER_PREFIX)) {
    return reminderText;
  }
  const userName = String(config?.userName || "").trim() || "the user";
  return `Due reminder for ${userName}: ${reminderText}`;
}

function buildScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function isAutoApprovedStateDirOperation(approval, config = {}) {
  const stateDir = normalizeText(config?.stateDir);
  if (!stateDir) {
    return false;
  }

  const filePaths = extractApprovalFilePaths(approval);
  if (!filePaths.length) {
    return false;
  }

  return filePaths.every((filePath) => isPathWithinRoot(filePath, stateDir));
}

function sortInboundUpdateMessages(messages) {
  return Array.isArray(messages)
    ? messages.slice().sort(compareRawInboundUpdateMessages)
    : [];
}

function compareRawInboundUpdateMessages(left, right) {
  const leftTime = resolveRawInboundMessageTimeMs(left);
  const rightTime = resolveRawInboundMessageTimeMs(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.message_id);
  const rightMessageId = parseMessageIdForOrdering(right?.message_id);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  const leftSeq = parseNumericOrderValue(left?.seq);
  const rightSeq = parseNumericOrderValue(right?.seq);
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  return String(left?.client_id || "").localeCompare(String(right?.client_id || ""));
}

function resolveRawInboundMessageTimeMs(message) {
  const createdAtMs = parseNumericOrderValue(message?.create_time_ms);
  if (createdAtMs > 0) {
    return createdAtMs;
  }
  const createdAtSeconds = parseNumericOrderValue(message?.create_time);
  return createdAtSeconds > 0 ? createdAtSeconds * 1000 : 0;
}

function comparePendingInboundMessages(left, right) {
  const leftTime = Date.parse(String(left?.receivedAt || "")) || 0;
  const rightTime = Date.parse(String(right?.receivedAt || "")) || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.messageId);
  const rightMessageId = parseMessageIdForOrdering(right?.messageId);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  return String(left?.text || "").localeCompare(String(right?.text || ""));
}

function parseMessageIdForOrdering(value) {
  const numeric = parseNumericOrderValue(value);
  return numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function parseNumericOrderValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const DEFERRED_REPLY_NOTICE = "由于微信 context_token 的限制，上轮对话里有一部分内容当时没能送达；这次用户再次发来消息、context_token 刷新后，先把遗留内容补上。如果这种情况反复出现，可发送 /chunk <数字>（例如 /chunk 50）调大最小合并字符数，减少消息分片。";
const DEFERRED_PLAIN_REPLY_HEADER = "===== 上轮对话遗留内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== 期间模型主动联系 =====";

function formatDeferredSystemReplyText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return DEFERRED_REPLY_NOTICE;
  }
  if (normalized.startsWith(DEFERRED_REPLY_NOTICE)) {
    return normalized;
  }
  return `${DEFERRED_REPLY_NOTICE}\n\n${normalized}`;
}

function formatDeferredSystemReplyBatch(replies) {
  const grouped = groupDeferredReplies(replies);
  if (!grouped.plain.length && !grouped.system.length) {
    return DEFERRED_REPLY_NOTICE;
  }
  const parts = [
    DEFERRED_REPLY_NOTICE,
  ];
  if (grouped.plain.length) {
    parts.push("", DEFERRED_PLAIN_REPLY_HEADER, grouped.plain.join("\n\n"));
  }
  if (grouped.system.length) {
    parts.push("", DEFERRED_SYSTEM_REPLY_HEADER, grouped.system.join("\n\n"));
  }
  return parts.join("\n");
}

function groupDeferredReplies(replies) {
  const grouped = { plain: [], system: [] };
  for (const reply of Array.isArray(replies) ? replies : []) {
    const normalizedText = String(reply?.text || "").trim();
    if (!normalizedText) {
      continue;
    }
    if (reply?.kind === "system_reply") {
      grouped.system.push(normalizedText);
      continue;
    }
    grouped.plain.push(normalizedText);
  }
  return grouped;
}

function formatWechatLocalTime(receivedAt) {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed).replace(/\//g, "-");
}

function stringifyRpcId(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function hasRpcId(value) {
  return stringifyRpcId(value) !== "";
}

function parseFallbackSystemAction(text) {
  const normalized = normalizeText(text).replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(normalized);
    return {
      action: normalizeText(parsed?.action),
      message: normalizeText(parsed?.message),
    };
  } catch {
    return { action: "", message: "" };
  }
}

function looksLikeWakeReentryText(text) {
  const body = normalizeCommandArgument(text);
  if (!body || !isWakeUpMessage(body)) {
    return false;
  }
  return !/(明天|后天|到时候|如果|等.*醒|醒了以后|醒来以后|wake.*tomorrow|when i wake)/i.test(body);
}

function buildBackfillSystemMessage(date) {
  return `[BACKFILL REQUEST date=${date}] [COMPLEX_TASK requires_tools=true no_deepseek_fallback=true]

如果你是 DeepSeek fallback 而非主 runtime（Codex/Claude），请直接回复 {"action":"silent"}，不要生成任何内容。此任务需要文件读写工具才能正确执行。

---

请补生成 ${date} 的 Obsidian Daily Review / 昨日时间轴报表。

数据源（按优先级读取）：
1. ~/.cyberboss/daily-inbox/${date}.md
2. ~/.cyberboss/apple-calendar-cache.json（过滤 ${date} 的事件）
3. ~/.cyberboss/missing-context-state.json（该日期的回答）
4. ~/.cyberboss/critical-habits-state.json（Level A/B/C）
5. ~/.cyberboss/shift-rating-state.json
6. ~/.cyberboss/pattern-ledger.json
7. ~/.cyberboss/wins-ledger.json
8. ~/.cyberboss/decision-journal.json

Obsidian 目标文件：03. 🔵 Tagebuch/01. 日记/${date}.md
- 如文件已有"待午夜后自动生成"占位符，整体填充
- 如文件已有部分内容，追加缺失 section，不要删除已有内容

原则：Meaning over Activity，不写 debug/技术日志噪音，缺失信息标记 unknown，重点帮助理解那一天。`;
}
