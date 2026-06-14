const { createChannelAdapter } = require("../adapters/channel");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { createTimelineIntegration } = require("../integrations/timeline");
const { CalendarService } = require("../services/calendar-service");
const { CampaignService } = require("../services/campaign-service");
const { CurrentStateService } = require("../services/current-state-service");
const { KnowledgeService } = require("../services/knowledge-service");
const { ObsidianNoteService } = require("../services/obsidian-note-service");
const { ObsidianTrackerSyncService } = require("../services/obsidian-tracker-sync-service");
const { ResearchLedgerService } = require("../services/research-ledger-service");
const { CalendarTimelineSyncService } = require("../services/calendar-timeline-sync-service");
const { ChannelFileService } = require("../services/channel-file-service");
const { DailyInboxService } = require("../services/daily-inbox-service");
const { DailyStateService } = require("../services/daily-state-service");
const { DayStrategyService } = require("../services/day-strategy-service");
const { DiaryService } = require("../services/diary-service");
const { FocusProtectionService } = require("../services/focus-protection-service");
const { HealthService } = require("../services/health-service");
const { MissingContextService } = require("../services/missing-context-service");
const { PatternLedgerService } = require("../services/pattern-ledger-service");
const { PlaybookService } = require("../services/playbook-service");
const { WinsService } = require("../services/wins-service");
const { DecisionJournalService } = require("../services/decision-journal-service");
const { PriorityAwarenessService } = require("../services/priority-awareness-service");
const { ReminderService } = require("../services/reminder-service");
const { ShiftRatingService } = require("../services/shift-rating-service");
const { StickerService } = require("../services/sticker-service");
const { SystemMessageService } = require("../services/system-message-service");
const { TimelineAutoCaptureService } = require("../services/timeline-auto-capture-service");
const { TimelineService } = require("../services/timeline-service");
const { Today3x3TimelineSyncService } = require("../services/today3x3-timeline-sync-service");
const { RuntimeContextStore } = require("./runtime-context-store");
const { ProjectToolHost } = require("./tool-host");
const { WhereaboutsService } = require("whereabouts-mcp");

function createProjectTooling(config, options = {}) {
  const sessionStore = options.sessionStore || new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: config.runtime || "codex",
  });
  const channelAdapter = options.channelAdapter || createChannelAdapter(config);
  const timelineIntegration = options.timelineIntegration || createTimelineIntegration(config);
  const runtimeContextStore = options.runtimeContextStore || new RuntimeContextStore({
    filePath: config.projectToolContextFile,
  });
  const channelFile = new ChannelFileService({ config, channelAdapter, sessionStore });
  const dailyInbox = new DailyInboxService({ config });
  const diary = new DiaryService({ config });
  const timeline = new TimelineService({ config, channelAdapter, timelineIntegration, sessionStore });
  const calendar = new CalendarService({ config });
  const health = new HealthService({ config, diary });
  const dailyState = new DailyStateService({ config, dailyInbox, timeline, calendar, health });
  const campaign = new CampaignService({ config });
  const patternLedger = new PatternLedgerService({ config });
  const currentState = new CurrentStateService({ config });
  const reminder = new ReminderService({ config, channelAdapter, sessionStore });
  const focusProtection = new FocusProtectionService({ config, reminder, timeline, channelAdapter, sessionStore });
  const missingContext = new MissingContextService({ config, dailyState, channelAdapter, sessionStore, currentState });
  const priorityAwareness = new PriorityAwarenessService({
    config,
    timeline,
    channelAdapter,
    sessionStore,
    focusProtection,
    currentState,
  });
  const dayStrategy = new DayStrategyService({
    config,
    dailyState,
    calendar,
    campaign,
    channelAdapter,
    sessionStore,
    focusProtection,
    currentState,
  });
  const services = {
    calendar,
    campaign,
    currentState,
    dayStrategy,
    playbook: new PlaybookService({ config }),
    knowledge: new KnowledgeService({ config }),
    obsidianNote: new ObsidianNoteService({ config }),
    obsidianTrackerSync: new ObsidianTrackerSyncService({ config }),
    researchLedger: new ResearchLedgerService({ config }),
    calendarTimelineSync: new CalendarTimelineSyncService({ config, calendar, timeline }),
    dailyInbox,
    dailyState,
    diary,
    focusProtection,
    health,
    missingContext,
    patternLedger,
    priorityAwareness,
    wins: new WinsService({ config }),
    decisionJournal: new DecisionJournalService({ config }),
    reminder,
    shiftRating: new ShiftRatingService({ config, channelAdapter }),
    system: new SystemMessageService({ config, channelAdapter, sessionStore }),
    channelFile,
    sticker: new StickerService({ config, channelAdapter, sessionStore, channelFileService: channelFile }),
    timeline,
    timelineAutoCapture: new TimelineAutoCaptureService({ config, timeline }),
    today3x3TimelineSync: new Today3x3TimelineSyncService({ config, timeline }),
    whereabouts: new WhereaboutsService({
      config: {
        storeFile: config.locationStoreFile,
        host: config.locationHost,
        port: config.locationPort,
        token: config.locationToken,
        historyLimit: config.locationHistoryLimit,
        movementEventLimit: config.locationMovementEventLimit,
        batteryHistoryLimit: config.locationBatteryHistoryLimit,
        knownPlaces: config.locationKnownPlaces,
        knownPlaceRadiusMeters: config.locationKnownPlaceRadiusMeters,
        stayMergeRadiusMeters: config.locationStayMergeRadiusMeters,
        stayBreakConfirmRadiusMeters: config.locationStayBreakConfirmRadiusMeters,
        stayBreakConfirmSamples: config.locationStayBreakConfirmSamples,
        majorMoveThresholdMeters: config.locationMajorMoveThresholdMeters,
      },
    }),
  };
  const toolHost = new ProjectToolHost({
    services,
    runtimeContextStore,
  });
  return {
    services,
    toolHost,
    runtimeContextStore,
  };
}

module.exports = { createProjectTooling };
