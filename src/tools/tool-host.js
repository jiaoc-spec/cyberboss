const { WhereaboutsToolHost } = require("whereabouts-mcp");
const {
  STICKER_DESC_GUIDANCE,
  STICKER_DESC_FIELD_DESCRIPTION,
  STICKER_TAG_GUIDANCE,
} = require("../services/sticker-service");

class ProjectToolHost {
  constructor({ services, runtimeContextStore }) {
    this.services = services;
    this.runtimeContextStore = runtimeContextStore;
    this.extraToolHosts = createExtraToolHosts(services);
  }

  listTools() {
    const builtIn = PROJECT_TOOLS.map((tool) => ({
      name: tool.name,
      description: buildToolDescription(tool),
      inputSchema: tool.inputSchema,
    }));
    const extra = this.extraToolHosts.flatMap((host) => host.listTools());
    return [...builtIn, ...extra];
  }

  async invokeTool(toolName, args = {}, context = {}) {
    const spec = PROJECT_TOOLS.find((candidate) => candidate.name === toolName);
    const normalizedArgs = args && typeof args === "object" ? args : {};
    if (spec) {
      validateSchema(spec.inputSchema, normalizedArgs, toolName, "input");
      const resolvedContext = this.resolveContext(context);
      return await spec.handler({
        services: this.services,
        args: normalizedArgs,
        context: resolvedContext,
      });
    }
    for (const host of this.extraToolHosts) {
      if (host.listTools().some((tool) => tool.name === toolName)) {
        return await host.invokeTool(toolName, normalizedArgs);
      }
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  resolveContext(context = {}) {
    const explicitWorkspaceRoot = normalizeText(context.workspaceRoot);
    const explicitRuntimeId = normalizeText(context.runtimeId);
    const active = this.runtimeContextStore.resolveActiveContext({
      workspaceRoot: explicitWorkspaceRoot,
      runtimeId: explicitRuntimeId,
    }) || {};
    return {
      runtimeId: explicitRuntimeId || normalizeText(active.runtimeId),
      workspaceRoot: explicitWorkspaceRoot || normalizeText(active.workspaceRoot),
      threadId: normalizeText(context.threadId) || normalizeText(active.threadId),
      bindingKey: normalizeText(context.bindingKey) || normalizeText(active.bindingKey),
      accountId: normalizeText(context.accountId) || normalizeText(active.accountId),
      senderId: normalizeText(context.senderId) || normalizeText(active.senderId),
    };
  }
}

function listProjectToolNames() {
  return [
    ...PROJECT_TOOLS.map((tool) => tool.name),
    ...STATIC_EXTRA_TOOL_NAMES,
  ];
}

const PROJECT_TOOLS = [
  {
    name: "cyberboss_calendar_read",
    description: "Read calendar events from the configured calendar provider. On macOS, the default Apple Calendar provider uses EventKit and the user's locally synced Apple/iCloud calendars.",
    shortHint: "Read Apple Calendar events for today or the next few days.",
    topics: ["calendar", "reminder", "timeline"],
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Optional provider. Current value: apple." },
        start: { type: "string", description: "Optional ISO datetime range start." },
        end: { type: "string", description: "Optional ISO datetime range end." },
        days: { type: "integer", description: "Optional number of days from start/today. Default 7." },
        calendars: {
          type: "array",
          description: "Optional Apple Calendar names to include.",
          items: { type: "string" },
        },
        includeNotes: { type: "boolean", description: "Whether to include event notes." },
        includeUrls: { type: "boolean", description: "Whether to include event URLs." },
        requestAccess: { type: "boolean", description: "Whether to trigger the macOS Calendar permission request when access has not been granted yet." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.calendar.read(args);
      return {
        text: `Calendar events loaded: ${Array.isArray(result?.events) ? result.events.length : 0}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_diary_append",
    description: "Append a cleaned, durable diary entry into the configured diary backend. When the Obsidian backend is enabled, use this for Growth Log summaries, important corrections, and reviews rather than raw chat capture.",
    shortHint: "Append a cleaned Growth Log or review entry.",
    topics: ["diary"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Diary body to append." },
        title: { type: "string", description: "Optional short entry title." },
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
        time: { type: "string", description: "Optional time in HH:mm." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.diary.append(args);
      return {
        text: `Diary appended to ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_daily_inbox_read",
    description: "Read the local raw Telegram/CyberBoss Daily Inbox for a date before producing a Daily Review. Raw inbox content is evidence, not final Obsidian knowledge.",
    shortHint: "Read a date's raw Daily Inbox before review.",
    topics: ["diary", "review", "inbox"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional date in YYYY-MM-DD. Default today." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.dailyInbox.read(args);
      return {
        text: result.exists ? `Daily Inbox loaded: ${result.filePath}` : `Daily Inbox missing: ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_daily_inbox_archive",
    description: "Archive a local raw Daily Inbox file after the Daily Review, Timeline, statistics, and durable Obsidian output have been completed successfully. This does not delete Telegram messages.",
    shortHint: "Archive a reviewed Daily Inbox date.",
    topics: ["diary", "review", "inbox"],
    inputSchema: {
      type: "object",
      required: ["date"],
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD to archive." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.dailyInbox.archive(args);
      return {
        text: result.archived ? `Daily Inbox archived: ${result.archivePath}` : `Daily Inbox not found: ${result.sourcePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_health_import",
    description: "Import pending Apple Health / Shortcuts export files from the configured health inbox into the diary backend, usually Obsidian Daily Notes.",
    shortHint: "Import Health inbox files into the Daily Note.",
    topics: ["health", "diary", "obsidian"],
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Maximum files to import this turn. Default 20." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.health.importPending(args);
      return {
        text: `Health imports completed: ${Array.isArray(result.imported) ? result.imported.length : 0}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_daily_state_read",
    description: "Read the synthesized Daily State for a date. Use before context-sensitive replies about what Jane is likely doing, whether she is currently working/on night shift, what Level A habits are done or missing, night-shift recovery, after-shift fatigue rating, calendar boundaries, energy/body signals, career growth signals, and whether to offer a minimum-version priority reminder.",
    shortHint: "Read today's synthesized life context.",
    topics: ["daily-state", "priority", "calendar", "timeline", "health"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional date in YYYY-MM-DD. Default today." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.dailyState.analyze(args);
      const missing = result.levelA.filter((item) => !item.completed).map((item) => item.label);
      return {
        text: `Daily State loaded for ${result.date}. Missing Level A: ${missing.join(", ") || "none"}. Mode: ${result.recommendedMode}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_pattern_ledger_read",
    description: "Read CyberBoss Longitudinal Memory / Pattern Ledger before Daily, Weekly, Monthly, or long-range reviews. Use this to connect today's evidence with patterns accumulated across days, weeks, and months instead of treating each review as isolated.",
    shortHint: "Read long-term patterns.",
    topics: ["review", "patterns", "longitudinal-memory", "second-brain"],
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Optional domain such as energy, night-shift, learning, sport, career, screen-time, emotion, research, dance." },
        status: { type: "string", description: "Optional status: hypothesis, active, confirmed, retired, contradicted." },
        tag: { type: "string" },
        query: { type: "string" },
        minConfidence: { type: "number" },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.patternLedger.read(args);
      const limited = args.limit ? { ...result, patterns: result.patterns.slice(0, args.limit), count: Math.min(result.count, args.limit) } : result;
      return {
        text: `Pattern Ledger loaded: ${limited.count}/${result.totalCount} patterns.`,
        data: limited,
      };
    },
  },
  {
    name: "cyberboss_pattern_ledger_upsert",
    description: "Create or update one long-term pattern after a review. Use when evidence suggests a recurring pattern, trend, correlation, return point, or self-understanding insight. Upsert by id when known, otherwise by domain + title.",
    shortHint: "Create or update a long-term pattern.",
    topics: ["review", "patterns", "longitudinal-memory", "second-brain"],
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        domain: { type: "string" },
        status: { type: "string", description: "hypothesis, active, confirmed, retired, or contradicted." },
        confidence: { type: "number", description: "0 to 1. Keep low when evidence is thin." },
        summary: { type: "string", description: "Short human-readable pattern summary." },
        hypothesis: { type: "string", description: "Possible explanation, clearly framed as hypothesis when uncertain." },
        impact: { type: "string", description: "How this affects Jane's long-term goals, energy, learning, health, or identity." },
        supportStrategy: { type: "string", description: "How CyberBoss should support Jane when this pattern appears again." },
        nextObservation: { type: "string", description: "What to watch next to confirm, revise, or retire this pattern." },
        tags: { type: "array", items: { type: "string" } },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string" },
              source: { type: "string", description: "daily-review, weekly-review, monthly-review, timeline, health, calendar, or user-report." },
              note: { type: "string" },
              weight: { type: "number" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.patternLedger.upsert(args);
      return {
        text: `${result.created ? "Pattern created" : "Pattern updated"}: ${result.pattern.title}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_pattern_ledger_add_evidence",
    description: "Add evidence to an existing Pattern Ledger item without rewriting the whole pattern.",
    shortHint: "Add evidence to a long-term pattern.",
    topics: ["review", "patterns", "longitudinal-memory", "second-brain"],
    inputSchema: {
      type: "object",
      required: ["patternId", "evidence"],
      properties: {
        patternId: { type: "string" },
        confidence: { type: "number" },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string" },
              source: { type: "string" },
              note: { type: "string" },
              weight: { type: "number" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.patternLedger.addEvidence(args);
      return {
        text: `Pattern evidence added: ${result.pattern.title}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_priority_set",
    description: "Set today's explicit priority-awareness commitments and their shared time boundary. Use this when the user says several things are important before sleep, leaving, work, or another deadline. Include realistic estimatedMinutes when the user gives a duration or when the default would be misleading. A list is unordered unless the user explicitly specifies an order.",
    shortHint: "Set an unordered priority set with a timezone-aware deadline and realistic duration estimates.",
    topics: ["priority", "reminder", "timeline"],
    inputSchema: {
      type: "object",
      required: ["priorities", "deadlineAt"],
      properties: {
        date: { type: "string", description: "Optional local date in YYYY-MM-DD. Default today." },
        deadlineAt: { type: "string", description: "Required timezone-aware ISO deadline, such as 2026-06-04T16:00:00+02:00." },
        deadlineLabel: { type: "string", description: "Human boundary label, such as 补觉, 出门, or 上班." },
        sourceText: { type: "string", description: "Optional original user wording for traceability." },
        priorities: {
          type: "array",
          items: {
            type: "object",
            required: ["label"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              level: { type: "string", description: "A, B, or C." },
              meaning: { type: "string" },
              estimatedMinutes: { type: "integer", description: "Expected minutes for the full intended version of this priority." },
              keywords: { type: "array", items: { type: "string" } },
              categoryPrefixes: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.priorityAwareness.set(args);
      return {
        text: `Priority awareness set for ${result.date}: ${result.priorities.map((item) => item.label).join(", ")}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_priority_status",
    description: "Read today's current priority-awareness state before replying about what is complete, still open, postponed, skipped, or cancelled.",
    shortHint: "Read the current priority-awareness state.",
    topics: ["priority", "reminder", "timeline"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional local date in YYYY-MM-DD. Default today." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.priorityAwareness.status(args);
      return {
        text: `Priority awareness state for ${result.date}: ${result.priorities.length} priorities.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_priority_update",
    description: "Update one priority-awareness commitment when the user completes, postpones, consciously skips, cancels, or reopens it.",
    shortHint: "Update a priority status.",
    topics: ["priority", "reminder", "timeline"],
    inputSchema: {
      type: "object",
      required: ["status"],
      properties: {
        date: { type: "string", description: "Optional local date in YYYY-MM-DD. Default today." },
        priorityId: { type: "string", description: "Priority id, such as sport, english, or german." },
        label: { type: "string", description: "Priority label when id is unknown." },
        status: { type: "string", description: "pending, unknown, completed, postponed, skipped, or cancelled." },
        note: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.priorityAwareness.update(args);
      return {
        text: `Priority awareness updated for ${result.date}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_reminder_create",
    description: "Create a reminder in Cyberboss.",
    shortHint: "Create a reminder with direct text plus delayMinutes or dueAt.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Reminder text to send back later." },
        delayMinutes: { type: "integer", description: "Minutes from now before the reminder fires." },
        dueAt: { type: "string", description: "Absolute time such as 2026-04-07T21:30+08:00." },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.reminder.create(args, context);
      return {
        text: `Reminder queued: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_system_send",
    description: "Queue an internal Cyberboss system trigger for the current bound workspace and chat.",
    shortHint: "Queue an internal system message for the current workspace.",
    topics: ["system"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        workspaceRoot: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = services.system.queueMessage(args, context);
      return {
        text: `System message queued: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_channel_send_file",
    description: "Send an existing local file back to the current WeChat chat.",
    shortHint: "Send a local file back to the current WeChat user.",
    topics: ["channel"],
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.channelFile.sendToCurrentChat(args, context);
      return {
        text: `File sent: ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_tags",
    description: `Load the current sticker tag catalog and tagging rules only when you have decided a sticker is needed or an inbox image should be saved as a sticker. ${STICKER_TAG_GUIDANCE}`,
    shortHint: "Load sticker tags only when needed.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = await services.sticker.listTags();
      return {
        text: `Sticker tags loaded: ${Array.isArray(result.tags) ? result.tags.length : 0}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_pick",
    description: "List a few saved sticker candidates for one sticker tag after you have decided a sticker would help.",
    shortHint: "Pick sticker candidates by tag.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["tag"],
      properties: {
        tag: { type: "string", description: "Sticker tag such as 可爱, 无语, 躺平, 感动, or OK." },
        limit: { type: "integer", description: "Optional maximum number of candidates to return." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.pick(args);
      return {
        text: `Sticker candidates loaded: ${result.candidates.length}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_send",
    description: "Send a saved sticker back to the current WeChat chat by sticker id.",
    shortHint: "Send a saved sticker by id.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["stickerId"],
      properties: {
        stickerId: { type: "string", description: "Sticker id such as stk_001." },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.sendToCurrentChat(args, context);
      return {
        text: `Sticker sent: ${result.stickerId}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_delete",
    description: "Delete one or more saved stickers by sticker id and remove their local GIF files.",
    shortHint: "Delete saved stickers by id array.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["stickerId"],
            properties: {
              stickerId: { type: "string", description: "Sticker id such as stk_001." },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.delete(args, context);
      return {
        text: `Sticker batch deleted: ${result.deletedCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_save_from_inbox",
    description: `Save one or more inbox images as reusable sticker GIFs after reading them all. Use an items array even for one sticker. ${STICKER_TAG_GUIDANCE} ${STICKER_DESC_GUIDANCE}`,
    shortHint: "Save inbox stickers with an items array.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          description: "One to ten inbox stickers to save in one call.",
          items: {
            type: "object",
            required: ["filePath", "tags", "desc"],
            properties: {
              filePath: { type: "string", description: "Absolute inbox image path under ~/.cyberboss/inbox." },
              tags: {
                type: "array",
                description: "One to three sticker tags. New short tags are allowed when the current catalog does not fit.",
                items: { type: "string" },
              },
              desc: { type: "string", description: STICKER_DESC_FIELD_DESCRIPTION },
            },
            additionalProperties: false,
          },
        },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.saveFromInbox(args, context);
      const duplicateNote = result.dedupedCount > 0
        ? " Existing stickers usually mean the user only sent them for you to see. Do not mention duplicates; just reply normally."
        : "";
      return {
        text: `Sticker batch processed: ${result.createdCount} saved, ${result.dedupedCount} already existed.${duplicateNote}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_update",
    description: `Overwrite tags and desc for one or more saved stickers. Use an items array even for one sticker. ${STICKER_TAG_GUIDANCE} ${STICKER_DESC_GUIDANCE}`,
    shortHint: "Overwrite stickers with an items array.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["stickerId", "tags", "desc"],
            properties: {
              stickerId: { type: "string", description: "Sticker id such as stk_001." },
              tags: {
                type: "array",
                description: "One to three sticker tags. New short tags are allowed when needed.",
                items: { type: "string" },
              },
              desc: { type: "string", description: STICKER_DESC_FIELD_DESCRIPTION },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.update(args);
      return {
        text: `Sticker batch updated: ${result.updatedCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_read",
    description: "Read the current timeline day data for a specific date. Use this before editing when the current day state is uncertain.",
    shortHint: "Read a timeline day before editing it.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date"],
      properties: {
        date: { type: "string", description: "Target date in YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.read(args);
      const exists = !!result?.data?.exists;
      const eventCount = Number.isInteger(result?.data?.eventCount) ? result.data.eventCount : 0;
      return {
        text: `Timeline day ${args.date}: ${exists ? `${eventCount} events` : "missing"}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_categories",
    description: "List the current timeline taxonomy categories, subcategories, and event nodes. Use this before choosing category ids or event nodes.",
    shortHint: "Inspect the current timeline taxonomy before choosing category ids or event nodes.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = await services.timeline.listCategories();
      const categoryCount = Number.isInteger(result?.data?.categoryCount) ? result.data.categoryCount : 0;
      return {
        text: `Timeline categories loaded: ${categoryCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_proposals",
    description: "List proposed timeline event nodes, optionally filtered by date. Use this when deciding whether a new event node is actually needed.",
    shortHint: "Inspect proposed timeline event nodes before introducing new taxonomy.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.listProposals(args);
      const proposalCount = Number.isInteger(result?.data?.proposalCount) ? result.data.proposalCount : 0;
      return {
        text: `Timeline proposals loaded: ${proposalCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_write",
    description: "Write timeline events through timeline-for-agent. Inspect the current day and taxonomy first when category ids, event nodes, or existing events are uncertain.",
    shortHint: "Write timeline events after checking the current day and taxonomy when needed.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date", "events"],
      properties: {
        date: { type: "string", description: "Target date in YYYY-MM-DD." },
        events: {
          type: "array",
          description: "Timeline events for the target date.",
          items: {
            type: "object",
            required: ["startAt", "endAt"],
            properties: {
              id: { type: "string" },
              startAt: { type: "string", description: "ISO datetime within the target date." },
              endAt: { type: "string", description: "ISO datetime within the target date." },
              title: { type: "string", description: "Event title. Required unless eventNodeId resolves a taxonomy label." },
              note: { type: "string" },
              description: { type: "string" },
              categoryId: { type: "string" },
              subcategoryId: { type: "string" },
              eventNodeId: { type: "string", description: "Timeline taxonomy node id. Use this or provide a title." },
              tags: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: true,
          },
        },
        locale: { type: "string", description: "Optional timeline locale." },
        mode: { type: "string", description: "Optional write mode, usually merge." },
        finalize: { type: "boolean", description: "Whether to finalize the day after writing." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      validateTimelineWriteArgs(args);
      const result = await services.timeline.write(args);
      services.priorityAwareness?.observeEvents({
        date: args.date,
        events: args.events,
      });
      return {
        text: "Timeline write completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_build",
    description: "Build the timeline site through timeline-for-agent.",
    shortHint: "Build the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.build(args);
      return {
        text: "Timeline build completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_serve",
    description: "Start the timeline static server through timeline-for-agent.",
    shortHint: "Serve the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.serve(args);
      return {
        text: result.url ? `Timeline serve started at ${result.url}` : "Timeline serve completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_dev",
    description: "Start the timeline dev server through timeline-for-agent.",
    shortHint: "Start the timeline dev server, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.dev(args);
      return {
        text: result.url ? `Timeline dev started at ${result.url}` : "Timeline dev completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_screenshot",
    description: "Capture a timeline screenshot and send it back to the current WeChat chat.",
    shortHint: "Capture a timeline screenshot with structured selection fields.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Optional explicit WeChat user id." },
        outputFile: { type: "string", description: "Optional absolute output path for the PNG file." },
        selector: { type: "string", description: "main, timeline, analytics, events, or a custom CSS selector." },
        range: { type: "string", description: "Optional range: day, week, or month." },
        date: { type: "string", description: "Optional day selector YYYY-MM-DD." },
        week: { type: "string", description: "Optional week key." },
        month: { type: "string", description: "Optional month selector YYYY-MM." },
        category: { type: "string", description: "Optional category label or id." },
        subcategory: { type: "string", description: "Optional subcategory label or id." },
        width: { type: "integer", description: "Optional viewport width in pixels." },
        height: { type: "integer", description: "Optional viewport height in pixels." },
        sidePadding: { type: "integer", description: "Optional screenshot padding in pixels." },
        locale: { type: "string", description: "Optional timeline locale." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const captured = await services.timeline.captureScreenshot(args);
      const delivery = await services.channelFile.sendToCurrentChat({
        userId: args.userId,
        filePath: captured.outputFile,
      }, context);
      return {
        text: `Timeline screenshot sent: ${captured.outputFile}`,
        data: {
          ...captured,
          delivery,
        },
      };
    },
  },
  {
    name: "cyberboss_wins_record",
    description: "Record a success event (win) with the key factor that made it possible. Call this after Jane completes a Level A/B habit and you want to capture what helped.",
    shortHint: "Record a win with success_factor.",
    topics: ["wins"],
    inputSchema: {
      type: "object",
      required: ["task", "success_factor"],
      properties: {
        task: { type: "string", description: "The habit or task completed, e.g. Sport, Englisch, Deutsch." },
        domain: { type: "string", description: "Domain: health, learning, career, wellbeing, etc." },
        success_factor: { type: "string", description: "Key success factor code. E.g. right_after_work, small_chunk, had_reminder, energy_good, good_environment, other." },
        evidence: { type: "string", description: "Optional: how it went or what made it concrete." },
        energy_context: { type: "string", description: "Optional energy level at the time: high, medium, low." },
        shift_context: { type: "string", description: "Optional work context: day_shift, night_shift, off, recovery." },
        reminder_context: { type: "string", description: "Optional: did a reminder help, yes or no." },
        note: { type: "string", description: "Optional free-text note." },
        date: { type: "string", description: "Optional date in YYYY-MM-DD. Defaults to today." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.wins.record(args);
      return {
        text: `Win recorded: ${result.id} task=${result.task} factor=${result.success_factor}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_wins_query",
    description: "Query the wins ledger to find success patterns. Use before Daily Review, Weekly Review, or when building pattern evidence.",
    shortHint: "Query wins ledger by task, domain, or date range.",
    topics: ["wins"],
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Filter by task name substring." },
        domain: { type: "string", description: "Filter by domain substring." },
        since: { type: "string", description: "Filter wins from this date (YYYY-MM-DD) onwards." },
        limit: { type: "integer", description: "Maximum number of wins to return (most recent first)." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.wins.query(args);
      return {
        text: `Wins query: ${result.total} results.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_decision_record",
    description: "Record an important decision to the Decision Journal. Only call when Jane confirms she wants to record a decision — do not auto-record every mention of plans.",
    shortHint: "Record a decision with context and expected outcome.",
    topics: ["decision"],
    inputSchema: {
      type: "object",
      required: ["decision"],
      properties: {
        decision: { type: "string", description: "The decision in one clear sentence." },
        context: { type: "string", description: "Background: what prompted this decision." },
        reasons: { type: "string", description: "Why this option was chosen." },
        expected_outcome: { type: "string", description: "What Jane expects to happen." },
        risks: { type: "string", description: "Downsides or risks she is aware of." },
        review_date: { type: "string", description: "Optional future date (YYYY-MM-DD) to revisit this decision." },
        date: { type: "string", description: "Optional date in YYYY-MM-DD. Defaults to today." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.decisionJournal.record(args);
      return {
        text: `Decision recorded: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_decision_update",
    description: "Update the later_outcome and reflection of an existing decision. Call during Weekly/Monthly Review or when Jane revisits a past decision.",
    shortHint: "Update a decision with outcome and reflection.",
    topics: ["decision"],
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Decision id such as dec_abc1234." },
        later_outcome: { type: "string", description: "What actually happened." },
        reflection: { type: "string", description: "What Jane thinks about the decision in retrospect." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.decisionJournal.updateOutcome(args);
      return {
        text: `Decision updated: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_decision_list",
    description: "List decisions from the Decision Journal. Use during Weekly/Monthly Review or when Jane asks about past decisions.",
    shortHint: "List decisions, optionally only pending review.",
    topics: ["decision"],
    inputSchema: {
      type: "object",
      properties: {
        pending_review_only: { type: "boolean", description: "If true, only return decisions without a later_outcome." },
        limit: { type: "integer", description: "Maximum number of decisions to return (most recent first)." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.decisionJournal.list(args);
      return {
        text: `Decision list: ${result.total} results.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_knowledge_capture",
    description: "Capture a piece of knowledge (insight, paper finding, quote, concept, learning note) into the Obsidian Knowledge Inbox with automatic related-note links. Use when Jane shares something worth keeping for her future studies or research — not for ordinary chat.",
    shortHint: "Save a knowledge note into Obsidian with backlinks.",
    topics: ["knowledge"],
    inputSchema: {
      type: "object",
      required: ["title", "content"],
      properties: {
        title: { type: "string", description: "Short descriptive title for the note." },
        content: { type: "string", description: "The knowledge content, cleaned up but faithful to what Jane said or read." },
        tags: { type: "array", items: { type: "string" }, description: "Topic tags, e.g. Wundmanagement, Pflegewissenschaft, Statistik." },
        source: { type: "string", description: "Where it came from: a paper title/DOI, a course, a conversation, a book." },
        date: { type: "string", description: "Optional date YYYY-MM-DD. Defaults to today." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.knowledge.capture(args);
      return {
        text: `Knowledge captured: ${result.title}${result.relatedNotes.length ? ` (related: ${result.relatedNotes.join(", ")})` : ""}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_knowledge_search",
    description: "Search Jane's Obsidian knowledge notes (Wissenskarte and Notizen) by keyword. Use during reviews or when a conversation touches a topic she may have notes about.",
    shortHint: "Search knowledge notes by keyword.",
    topics: ["knowledge"],
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Keyword or phrase to search for." },
        limit: { type: "integer", description: "Maximum results, default 8." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.knowledge.search(args);
      return {
        text: `Knowledge search "${result.query}": ${result.results.length} results.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_research_record",
    description: "Record an academic asset into the Research Ledger: a paper read (type=paper), a research idea (idea), writing produced (writing), an academic contact (contact), or a course milestone (course). This is the compounding record of Jane's path toward research and professorship.",
    shortHint: "Record paper/idea/writing/contact/course into the research ledger.",
    topics: ["research"],
    inputSchema: {
      type: "object",
      required: ["type", "title"],
      properties: {
        type: { type: "string", description: "One of: paper, idea, writing, contact, course, other." },
        title: { type: "string", description: "Title of the paper/idea/writing piece, or the person's name for contacts." },
        note: { type: "string", description: "Key takeaway, idea description, or context." },
        link: { type: "string", description: "Optional DOI, URL, or Obsidian note name." },
        tags: { type: "array", items: { type: "string" }, description: "Topic tags." },
        date: { type: "string", description: "Optional date YYYY-MM-DD. Defaults to today." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.researchLedger.record(args);
      return {
        text: `Research asset recorded: ${result.id} type=${result.type}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_research_query",
    description: "Query the Research Ledger. Use during Weekly/Monthly Review to summarize how Jane's academic assets grew, or when she asks what she has read/produced.",
    shortHint: "Query research ledger by type, text, or date range.",
    topics: ["research"],
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Filter by type: paper, idea, writing, contact, course, other." },
        query: { type: "string", description: "Substring filter across title/note/tags." },
        from: { type: "string", description: "Start date YYYY-MM-DD inclusive." },
        to: { type: "string", description: "End date YYYY-MM-DD inclusive." },
        limit: { type: "integer", description: "Maximum results (most recent first)." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.researchLedger.query(args);
      return {
        text: `Research query: ${result.total} results.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_campaign_set",
    description: "Create or update a Campaign: a time-bounded goal container like a semester, exam period, or application sprint. Deadlines may reference a habit id (e.g. python, wundmanagement, pflegewissenschaft); when a deadline is within the boost window the habit temporarily joins the daily Level A guardian set. Confirm with Jane before creating.",
    shortHint: "Create/update a semester or exam campaign with deadlines.",
    topics: ["campaign"],
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        id: { type: "string", description: "Existing campaign id to update; omit to create." },
        name: { type: "string", description: "Campaign name, e.g. WS 2026/27 Semester 1." },
        startDate: { type: "string", description: "Start date YYYY-MM-DD." },
        endDate: { type: "string", description: "End date YYYY-MM-DD." },
        note: { type: "string", description: "Optional description or goals." },
        deadlines: {
          type: "array",
          description: "Deadlines inside the campaign.",
          items: {
            type: "object",
            required: ["label", "date"],
            properties: {
              label: { type: "string", description: "Deadline name, e.g. Statistik Klausur." },
              date: { type: "string", description: "Date YYYY-MM-DD." },
              habitId: { type: "string", description: "Optional habit id to boost as the deadline approaches." },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.campaign.upsert(args);
      return {
        text: `Campaign saved: ${result.id} ${result.name} (${result.deadlines.length} deadlines)`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_campaign_status",
    description: "Show active campaigns and upcoming deadlines, including which habits are currently boosted. Use when planning a day/week or when Jane asks what is coming up.",
    shortHint: "List active campaigns and upcoming deadlines.",
    topics: ["campaign"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional date YYYY-MM-DD. Defaults to today." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.campaign.status(args);
      return {
        text: `Campaigns: ${result.activeCampaigns.length} active, ${result.upcomingDeadlines.length} upcoming deadlines.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_focus_start",
    description: "Start a timed focus session immediately for the current chat user. Use when Jane replies with a digit (1) or agreement to a Playbook prompt, or asks to start a task right now. Creates the protected session and the end-of-session completion check automatically.",
    shortHint: "One-touch start of a timed focus session.",
    topics: ["focus", "playbook"],
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "Task name, e.g. Sport, Englisch, Deutsch, Python." },
        minutes: { type: "integer", description: "Session length in minutes. Default 10." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.focusProtection.startQuick(args);
      return {
        text: `Focus started: ${result.session.task} for ${result.minutes} minutes (ends ${result.session.endAt}).`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_playbook_set",
    description: "Create or update a Playbook rule: a pre-decided default action bound to an anchor moment (arrived_home, off_work, commuting_home, woke_up, going_to_sleep). Use when Jane expresses an if-then intention like 以后我到家就先运动十分钟. This removes in-the-moment decision cost.",
    shortHint: "Set an if-then default action for an anchor moment.",
    topics: ["playbook"],
    inputSchema: {
      type: "object",
      required: ["anchor", "task", "label"],
      properties: {
        id: { type: "string", description: "Existing rule id to update; omit to create." },
        anchor: { type: "string", description: "One of: arrived_home, off_work, commuting_home, woke_up, going_to_sleep." },
        task: { type: "string", description: "Task name used for focus sessions, e.g. Sport, Deutsch, Englisch, Python." },
        label: { type: "string", description: "Human label shown to Jane, e.g. 运动 10 分钟（最小版）." },
        minutes: { type: "integer", description: "Focus session length in minutes. Default 10." },
        hours: {
          type: "object",
          description: "Hour window when the rule may fire, local time.",
          properties: {
            from: { type: "integer", description: "Earliest hour (0-23)." },
            to: { type: "integer", description: "Hour before which it must fire (1-24)." },
          },
          additionalProperties: false,
        },
        graceMinutes: { type: "integer", description: "Delay between the anchor moment and the prompt, in minutes. Defaults: woke_up 60 (her morning routine comes first), arrived_home 10, others 0." },
        note: { type: "string", description: "Optional note about why or how to adjust." },
        enabled: { type: "boolean", description: "Set false to pause the rule without deleting it." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.playbook.upsertRule(args);
      return {
        text: `Playbook rule saved: ${result.id} ${result.anchor} → ${result.label}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_playbook_list",
    description: "List Playbook rules (pre-decided anchor → default action mappings). Use when Jane asks what her defaults are or wants to adjust them.",
    shortHint: "List playbook rules.",
    topics: ["playbook"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = await services.playbook.list();
      return {
        text: `Playbook: ${result.rules.length} rules.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_playbook_remove",
    description: "Remove a Playbook rule by id when Jane no longer wants that default.",
    shortHint: "Remove a playbook rule.",
    topics: ["playbook"],
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Rule id such as pb_abc1234." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.playbook.removeRule(args);
      return {
        text: `Playbook rule removed: ${result.removed}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_obsidian_note_read",
    description: "Read an Obsidian note inside the daily/weekly/monthly/knowledge folders without sandbox approval. Path is relative to the vault root, e.g. 03. 🔵 Tagebuch/01. 日记/2026-06-11.md.",
    shortHint: "Read a vault note (no approval needed).",
    topics: ["obsidian"],
    inputSchema: {
      type: "object",
      required: ["relativePath"],
      properties: {
        relativePath: { type: "string", description: "Note path relative to the vault root, must end in .md." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.obsidianNote.read(args);
      return {
        text: result.exists ? `Read ${result.relativePath} (${result.text.length} chars).` : `Note not found: ${result.relativePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_obsidian_note_write",
    description: "Write review/report content into an Obsidian note WITHOUT sandbox approval - the bridge writes the file directly. ALWAYS use this for Daily/Weekly/Monthly Review output instead of shell or patch edits, which trigger a human approval prompt and break unattended midnight runs. mode=replace_placeholder fills the 待午夜后自动生成 placeholder (falls back to append); mode=append adds to the end. Never deletes existing content. Restricted to the daily/weekly/monthly/knowledge folders.",
    shortHint: "Write a vault note without approval (append or fill placeholder).",
    topics: ["obsidian"],
    inputSchema: {
      type: "object",
      required: ["relativePath", "content"],
      properties: {
        relativePath: { type: "string", description: "Note path relative to the vault root, must end in .md." },
        content: { type: "string", description: "Markdown content to write." },
        mode: { type: "string", description: "append (default) or replace_placeholder." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.obsidianNote.write(args);
      return {
        text: `Note ${result.action}: ${result.relativePath}`,
        data: result,
      };
    },
  },
];

const STATIC_EXTRA_TOOL_NAMES = new WhereaboutsToolHost({ service: null })
  .listTools()
  .map((tool) => tool.name);

function createExtraToolHosts(services = {}) {
  const hosts = [];
  if (services.whereabouts) {
    hosts.push(new WhereaboutsToolHost({ service: services.whereabouts }));
  }
  return hosts;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildToolDescription(tool) {
  const baseDescription = normalizeText(tool?.description);
  const signature = summarizeSchema(tool?.inputSchema);
  if (!signature) {
    return baseDescription;
  }
  return `${baseDescription} Input: ${signature}`;
}

function summarizeSchema(schema, { depth = 0 } = {}) {
  if (!schema || typeof schema !== "object") {
    return "";
  }
  const schemaType = normalizeText(schema.type).toLowerCase();
  if (schemaType === "object") {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(properties);
    if (!entries.length) {
      return "{}";
    }
    const parts = entries.map(([key, value]) => {
      const suffix = required.has(key) ? "" : "?";
      return `${key}${suffix}: ${summarizeSchema(value, { depth: depth + 1 }) || "any"}`;
    });
    return `{ ${parts.join(", ")} }`;
  }
  if (schemaType === "array") {
    const itemSummary = summarizeSchema(schema.items, { depth: depth + 1 }) || "any";
    return `${itemSummary}[]`;
  }
  if (schemaType === "integer" || schemaType === "number" || schemaType === "string" || schemaType === "boolean") {
    return schemaType;
  }
  return schemaType || "any";
}

function validateTimelineWriteArgs(args) {
  const events = Array.isArray(args?.events) ? args.events : [];
  events.forEach((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return;
    }
    const hasTitle = normalizeText(event.title).length > 0;
    const hasEventNodeId = normalizeText(event.eventNodeId).length > 0;
    if (!hasTitle && !hasEventNodeId) {
      throw new Error(`cyberboss_timeline_write input.events[${index}].title or input.events[${index}].eventNodeId is required.`);
    }
  });
}

function validateSchema(schema, value, toolName, path) {
  if (!schema || typeof schema !== "object") {
    return;
  }
  const schemaType = schema.type;
  if (schemaType === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${toolName} ${path} must be an object.`);
    }
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        throw new Error(`${toolName} ${path}.${key} is required.`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          throw new Error(`${toolName} ${path}.${key} is not allowed.`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        validateSchema(propertySchema, value[key], toolName, `${path}.${key}`);
      }
    }
    return;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${toolName} ${path} must be an array.`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchema(schema.items, item, toolName, `${path}[${index}]`));
    }
    return;
  }
  if (schemaType === "string" && typeof value !== "string") {
    throw new Error(`${toolName} ${path} must be a string.`);
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    throw new Error(`${toolName} ${path} must be a boolean.`);
  }
  if (schemaType === "integer" && !Number.isInteger(value)) {
    throw new Error(`${toolName} ${path} must be an integer.`);
  }
  if (schemaType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${toolName} ${path} must be a number.`);
  }
}

module.exports = {
  ProjectToolHost,
  listProjectToolNames,
};
