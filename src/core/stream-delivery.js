const { sanitizeProtocolLeakText } = require("../adapters/runtime/codex/protocol-leak-monitor");

const CURRENT_REPLY_HEADER = "===== 本轮模型回复 =====";
const EMPTY_MODEL_REPLY_FALLBACK = "收到，这条我记下了。刚刚没接住话，等下再好好回你。";

class StreamDelivery {
  constructor({ channelAdapter, sessionStore, runtimeId = "", onDeferredSystemReply, onEmptyReply, systemReplyRetryScheduleMs, sameTokenRetryDelayMs }) {
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.runtimeId = normalizeRuntimeId(runtimeId);
    this.systemReplyPolicy = createSystemReplyPolicy(this.runtimeId);
    this.onDeferredSystemReply = typeof onDeferredSystemReply === "function" ? onDeferredSystemReply : null;
    this.onEmptyReply = typeof onEmptyReply === "function" ? onEmptyReply : null;
    this.systemReplyRetryScheduleMs = Array.isArray(systemReplyRetryScheduleMs) && systemReplyRetryScheduleMs.length
      ? systemReplyRetryScheduleMs.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
      : [1_500, 2_500, 4_000, 6_000];
    this.sameTokenRetryDelayMs = Number.isFinite(sameTokenRetryDelayMs) && sameTokenRetryDelayMs >= 0
      ? sameTokenRetryDelayMs
      : 800;
    this.replyTargetByBindingKey = new Map();
    this.replyTargetByTurnKey = new Map();
    this.replyTargetQueueByThreadId = new Map();
    this.deferredReplyPrefixByBindingKey = new Map();
    this.stateByRunKey = new Map();
    this.runSequence = 0;
  }

  setReplyTarget(bindingKey, target) {
    if (!bindingKey || !target?.userId || !target?.contextToken) {
      return;
    }
    this.replyTargetByBindingKey.set(bindingKey, {
      userId: String(target.userId).trim(),
      contextToken: String(target.contextToken).trim(),
      provider: normalizeText(target.provider),
    });
  }

  queueReplyTargetForThread(threadId, target) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTarget) {
      return;
    }
    const queue = this.replyTargetQueueByThreadId.get(normalizedThreadId) || [];
    queue.push(normalizedTarget);
    this.replyTargetQueueByThreadId.set(normalizedThreadId, queue);
    this.bindQueuedReplyTargetsToActiveThreadRuns(normalizedThreadId);
  }

  bindReplyTargetForTurn({ threadId = "", turnId = "", target = null } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTurnId || !normalizedTarget) {
      this.queueReplyTargetForThread(normalizedThreadId, target);
      return;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    this.replyTargetByTurnKey.set(runKey, normalizedTarget);
    const activeState = this.stateByRunKey.get(runKey);
    if (activeState) {
      this.applyThreadReplyTarget(activeState, normalizedTarget);
    }
  }

  setDeferredReplyPrefix(bindingKey, text) {
    const normalizedBindingKey = normalizeText(bindingKey);
    const normalizedText = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalizedBindingKey || !normalizedText) {
      return;
    }
    this.deferredReplyPrefixByBindingKey.set(normalizedBindingKey, normalizedText);
  }

  resolveReplyTargetForRun({ threadId = "", turnId = "" } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId) {
      return null;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    const state = this.stateByRunKey.get(runKey);
    if (state?.replyTarget) {
      return normalizeReplyTarget(state.replyTarget);
    }

    const exactTurnTarget = this.replyTargetByTurnKey.get(runKey);
    if (exactTurnTarget) {
      return normalizeReplyTarget(exactTurnTarget);
    }

    const queuedTargets = this.replyTargetQueueByThreadId.get(normalizedThreadId);
    if (Array.isArray(queuedTargets) && queuedTargets.length > 0) {
      return normalizeReplyTarget(queuedTargets[0]);
    }

    const linked = this.sessionStore.findBindingForThreadId(normalizedThreadId);
    if (!linked?.bindingKey) {
      return null;
    }
    return normalizeReplyTarget(this.replyTargetByBindingKey.get(linked.bindingKey));
  }

  async handleRuntimeEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    if (!threadId) {
      return;
    }

    switch (event.type) {
      case "runtime.turn.started": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.attachReplyTarget(state);
        return;
      }
      case "runtime.reply.delta": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: false,
        });
        return;
      }
      case "runtime.reply.completed": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: true,
        });
        await this.flush(state, { force: false });
        return;
      }
      case "runtime.turn.completed": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.captureTurnCompletionText(state, event.payload.text);
        await this.sendEmptyReplyFallbackIfNeeded(state);
        await this.flush(state, { force: true });
        this.disposeRunState(state.runKey);
        return;
      }
      case "runtime.turn.failed":
        this.disposeRunState(buildRunKey(threadId, turnId));
        return;
      default:
        return;
    }
  }

  ensureRunState(threadId, turnId = "") {
    const runKey = buildRunKey(threadId, turnId);
    const existing = this.stateByRunKey.get(runKey);
    if (existing) {
      return existing;
    }

    const created = {
      runKey,
      threadId,
      bindingKey: "",
      replyTarget: null,
      deferredReplyPrefix: "",
      turnId: normalizeText(turnId),
      itemOrder: [],
      items: new Map(),
      sentItemIds: new Set(),
      sendChain: Promise.resolve(),
      flushPromise: null,
      sequence: this.runSequence += 1,
      threadReplyTargetAttached: false,
    };
    this.stateByRunKey.set(runKey, created);
    this.attachReplyTarget(created);
    return created;
  }

  attachReplyTarget(state) {
    if (!state.threadReplyTargetAttached && state.turnId) {
      const exactTurnTarget = this.replyTargetByTurnKey.get(buildRunKey(state.threadId, state.turnId)) || null;
      if (exactTurnTarget) {
        this.applyThreadReplyTarget(state, exactTurnTarget);
      }
    }
    if (!state.threadReplyTargetAttached) {
      const threadTarget = this.consumeQueuedReplyTarget(state.threadId);
      if (threadTarget) {
        this.applyThreadReplyTarget(state, threadTarget);
      }
    }
    const linked = this.sessionStore.findBindingForThreadId(state.threadId);
    if (!linked?.bindingKey) {
      return;
    }
    state.bindingKey = linked.bindingKey;
    if (!state.replyTarget) {
      const target = this.replyTargetByBindingKey.get(linked.bindingKey);
      state.replyTarget = target;
    }
    if (!state.deferredReplyPrefix) {
      const prefix = this.deferredReplyPrefixByBindingKey.get(linked.bindingKey) || "";
      if (prefix) {
        state.deferredReplyPrefix = prefix;
        this.deferredReplyPrefixByBindingKey.delete(linked.bindingKey);
      }
    }
  }

  captureTurnCompletionText(state, text) {
    const normalized = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalized || state.itemOrder.length > 0) {
      return;
    }
    this.upsertItem(state, {
      itemId: `result-${state.turnId || state.threadId}`,
      text: normalized,
      completed: true,
    });
  }

  async sendEmptyReplyFallbackIfNeeded(state) {
    if (!state.replyTarget || state.itemOrder.length > 0) {
      return;
    }
    if (this.onEmptyReply) {
      const handled = await this.onEmptyReply({
        threadId: state.threadId,
        turnId: state.turnId,
        replyTarget: normalizeReplyTarget(state.replyTarget),
      }).catch(() => false);
      if (handled) {
        return;
      }
    }
    if (state.replyTarget.provider === "system") {
      return;
    }
    console.warn(
      `[cyberboss] empty model reply fallback thread=${state.threadId} turn=${state.turnId} provider=${state.replyTarget.provider || ""}`
    );
    await this.sendTextWithRetry(state, {
      userId: state.replyTarget.userId,
      text: EMPTY_MODEL_REPLY_FALLBACK,
      contextToken: state.replyTarget.contextToken,
    }, { kind: "plain_reply" });
  }

  upsertItem(state, { itemId, text, completed }) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
      });
    }

    const current = state.items.get(itemId);
    if (completed) {
      current.currentText = text;
      current.completedText = text;
      current.completed = true;
      return;
    }

    current.currentText = appendStreamingText(current.currentText, text);
  }

  setItemText(state, itemId, text, completed) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
      });
    }

    const current = state.items.get(itemId);
    current.currentText = text;
    if (completed) {
      current.completedText = text;
    }
    current.completed = Boolean(completed);
  }

  async flush(state, { force }) {
    const previous = state.flushPromise || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.flushNow(state, { force }));
    const tracked = current.finally(() => {
      const latestState = this.stateByRunKey.get(state.runKey);
      if (latestState && latestState.flushPromise === tracked) {
        latestState.flushPromise = null;
      }
    });
    state.flushPromise = tracked;
    await tracked;
  }

  async flushNow(state, { force }) {
    if (!state.replyTarget) {
      return;
    }

    if (state.replyTarget.provider === "system") {
      await this.flushSystemReply(state, { force });
      return;
    }

    const pendingDeliveries = collectPendingReplyDeliveries(state, { force });
    if (!pendingDeliveries.length) {
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      for (let index = 0; index < pendingDeliveries.length; index += 1) {
        const delivery = pendingDeliveries[index];
        await this.sendReplyDelivery(state, delivery, {
          prependDeferredPrefix: index === 0 && Boolean(state.deferredReplyPrefix),
        });
        state.sentItemIds.add(delivery.itemId);
        if (index === 0 && state.deferredReplyPrefix) {
          state.deferredReplyPrefix = "";
        }
      }
    }).catch((error) => {
      const failedDelivery = pendingDeliveries[0];
      const failedText = buildDeliveryPreviewText(failedDelivery);
      void this.deferSystemReply(state, buildEffectiveReplyText(state.deferredReplyPrefix, failedText), error, "plain_reply");
      console.error(`[cyberboss] failed to deliver reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async flushSystemReply(state, { force }) {
    if (!force) {
      return;
    }

    const replyText = buildReplyText(state, { completedOnly: false });
    if (!replyText.trim()) {
      if (this.onEmptyReply) {
        const handled = await this.onEmptyReply({
          threadId: state.threadId,
          turnId: state.turnId,
          replyTarget: normalizeReplyTarget(state.replyTarget),
        }).catch(() => false);
        if (handled) {
          this.markAllItemsSent(state);
          return;
        }
      }
      this.markAllItemsSent(state);
      console.log(`[cyberboss] empty system reply treated as silent thread=${state.threadId}`);
      return;
    }
    const resolved = resolveSystemReplyDelivery(replyText, this.systemReplyPolicy);
    if (resolved.kind === "silent") {
      this.markAllItemsSent(state);
      console.log(
        `[cyberboss] suppressed system reply thread=${state.threadId} action=silent preview=${JSON.stringify(replyText.slice(0, 120))}`
      );
      return;
    }

    if (resolved.kind !== "send_message") {
      console.error(
        `[cyberboss] invalid system reply thread=${state.threadId} reason=${resolved.reason} preview=${JSON.stringify(replyText.slice(0, 160))}`
      );
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      await this.sendSystemReply(state, resolved.message);
      this.markAllItemsSent(state);
    }).catch((error) => {
      console.error(`[cyberboss] failed to deliver system reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async sendReplyDelivery(state, delivery, { prependDeferredPrefix = false } = {}) {
    if (!delivery || !state.replyTarget) {
      return;
    }

    if (delivery.kind === "silent") {
      return;
    }

    if (delivery.kind === "invalid_action") {
      console.error(
        `[cyberboss] invalid structured action item thread=${state.threadId} reason=${delivery.reason} preview=${JSON.stringify((delivery.sourceText || "").slice(0, 160))}`
      );
      return;
    }

    const baseText = delivery.kind === "action" ? delivery.message : delivery.text;
    if (!baseText) {
      return;
    }

    const payload = {
      userId: state.replyTarget.userId,
      text: prependDeferredPrefix ? buildEffectiveReplyText(state.deferredReplyPrefix, baseText) : baseText,
      contextToken: state.replyTarget.contextToken,
    };
    if (prependDeferredPrefix) {
      payload.preserveBlock = true;
    }
    await this.sendTextWithRetry(state, payload, { kind: "plain_reply" });
  }

  async sendSystemReply(state, text) {
    const initialTarget = state.replyTarget;
    const payload = {
      userId: initialTarget.userId,
      text,
      contextToken: initialTarget.contextToken,
    };
    await this.sendTextWithRetry(state, payload, { kind: "system_reply" });
  }

  async sendTextWithRetry(state, payload, { kind }) {
    const initialTarget = state.replyTarget;
    try {
      await this.channelAdapter.sendText(payload);
      return;
    } catch (error) {
      const retryTarget = this.resolveRetriableReplyTarget(initialTarget, error);
      if (!retryTarget) {
        const deferred = await this.deferSystemReply(state, payload.text, error, kind);
        if (deferred) {
          return;
        }
        throw error;
      }
      console.warn(
        `[cyberboss] system reply retrying with refreshed context token thread=${state.threadId} user=${retryTarget.userId}`
      );
      try {
        const retryPayload = {
          userId: retryTarget.userId,
          text: payload.text,
          contextToken: retryTarget.contextToken,
        };
        if (payload.preserveBlock) {
          retryPayload.preserveBlock = true;
        }
        await this.channelAdapter.sendText(retryPayload);
        state.replyTarget = retryTarget;
        if (state.bindingKey) {
          this.replyTargetByBindingKey.set(state.bindingKey, {
            userId: retryTarget.userId,
            contextToken: retryTarget.contextToken,
            provider: retryTarget.provider,
          });
        }
      } catch (retryError) {
        const deferred = await this.deferSystemReply(state, payload.text, retryError, kind);
        if (deferred) {
          return;
        }
        throw retryError;
      }
    }
  }

  async deferSystemReply(state, text, error, kind = "plain_reply") {
    if (typeof this.onDeferredSystemReply !== "function") {
      return false;
    }
    if (!isSystemReplyContextFailure(error)) {
      return false;
    }
    const target = state?.replyTarget || {};
    if (!target.userId || !text) {
      return false;
    }
    try {
      await this.onDeferredSystemReply({
        threadId: state.threadId,
        userId: target.userId,
        text,
        error,
        kind,
      });
      console.warn(
        `[cyberboss] deferred system reply until the next inbound message thread=${state.threadId} user=${target.userId}`
      );
      return true;
    } catch (deferError) {
      console.error(`[cyberboss] failed to defer system reply thread=${state.threadId}: ${deferError.message}`);
      return false;
    }
  }

  resolveRetriableReplyTarget(currentTarget, error) {
    if (!isSystemReplyContextFailure(error)) {
      return null;
    }
    if (!currentTarget?.userId) {
      return null;
    }
    if (typeof this.channelAdapter.getKnownContextTokens !== "function") {
      return null;
    }
    const tokens = this.channelAdapter.getKnownContextTokens();
    const refreshedContextToken = normalizeText(tokens?.[currentTarget.userId]);
    if (!refreshedContextToken || refreshedContextToken === currentTarget.contextToken) {
      return null;
    }
    return {
      userId: currentTarget.userId,
      contextToken: refreshedContextToken,
      provider: currentTarget.provider,
    };
  }

  disposeRunState(runKey) {
    const normalizedRunKey = normalizeText(runKey);
    if (!normalizedRunKey) {
      return;
    }
    this.replyTargetByTurnKey.delete(normalizedRunKey);
    this.stateByRunKey.delete(normalizedRunKey);
  }

  bindQueuedReplyTargetsToActiveThreadRuns(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return;
    }
    const states = [...this.stateByRunKey.values()]
      .filter((state) => state.threadId === threadId && !state.threadReplyTargetAttached)
      .sort((left, right) => left.sequence - right.sequence);
    for (const state of states) {
      const nextTarget = queue.shift();
      if (!nextTarget) {
        break;
      }
      this.applyThreadReplyTarget(state, nextTarget);
    }
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
      return;
    }
    this.replyTargetQueueByThreadId.delete(threadId);
  }

  consumeQueuedReplyTarget(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return null;
    }
    const target = queue.shift() || null;
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
    } else {
      this.replyTargetQueueByThreadId.delete(threadId);
    }
    return target;
  }

  applyThreadReplyTarget(state, target) {
    state.replyTarget = {
      userId: target.userId,
      contextToken: target.contextToken,
      provider: target.provider,
    };
    state.threadReplyTargetAttached = true;
  }

  markAllItemsSent(state) {
    for (const itemId of state.itemOrder) {
      state.sentItemIds.add(itemId);
    }
  }
}

function buildRunKey(threadId, turnId = "") {
  const normalizedThreadId = normalizeText(threadId);
  const normalizedTurnId = normalizeText(turnId);
  return normalizedTurnId
    ? `${normalizedThreadId}:${normalizedTurnId}`
    : `${normalizedThreadId}:pending`;
}

function buildReplyText(state, { completedOnly }) {
  const parts = [];
  for (const itemId of state.itemOrder) {
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }

    const sourceText = completedOnly
      ? (item.completed ? item.completedText : "")
      : (item.completed ? item.completedText : item.currentText);
    const normalized = trimOuterBlankLines(sourceText);
    if (normalized) {
      parts.push(normalized);
    }
  }
  return parts.join("\n\n");
}

function collectPendingReplyDeliveries(state, { force }) {
  const pending = [];
  for (const itemId of state.itemOrder) {
    if (state.sentItemIds.has(itemId)) {
      continue;
    }
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }
    const sourceText = resolvePlainReplySourceText(item, force);
    if (!sourceText) {
      continue;
    }
    const structuredAction = classifyReplyItemSourceText(sourceText);
    if (structuredAction) {
      pending.push(buildActionDelivery(itemId, sourceText, structuredAction));
      continue;
    }
    const plainText = markdownToPlainText(sourceText);
    const sanitizedText = sanitizeReplyText(plainText);
    if (!sanitizedText) {
      continue;
    }
    pending.push({ itemId, kind: "plain", text: sanitizedText });
  }
  return pending;
}

function resolvePlainReplySourceText(item, force) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.completed) {
    return trimOuterBlankLines(item.completedText || item.currentText || "");
  }
  if (!force) {
    return "";
  }
  return trimOuterBlankLines(item.currentText || "");
}

function buildEffectiveReplyText(deferredPrefix, replyText) {
  const prefix = trimOuterBlankLines(normalizeLineEndings(deferredPrefix));
  const body = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (prefix && body) {
    return `${prefix}\n\n${CURRENT_REPLY_HEADER}\n${body}`;
  }
  return prefix || body;
}

function markdownToPlainText(text) {
  let result = normalizeLineEndings(text);
  result = result.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/```([^\n]*)\n?([\s\S]*)$/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^#{1,6}\s*(.+)$/gm, "$1");
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/^>\s?/gm, "> ");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner) =>
    String(inner || "").split("|").map((cell) => cell.trim()).join("  ")
  );
  result = result.replace(/\n{3,}/g, "\n\n");
  return trimOuterBlankLines(result);
}

function appendStreamingText(current, next) {
  const base = String(current || "");
  const incoming = String(next || "");
  if (!incoming) {
    return base;
  }
  if (!base) {
    return incoming;
  }
  if (base.endsWith(incoming)) {
    return base;
  }
  if (incoming.startsWith(base)) {
    return incoming;
  }

  const maxOverlap = Math.min(base.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === incoming.slice(0, size)) {
      return `${base}${incoming.slice(size)}`;
    }
  }

  return `${base}${incoming}`;
}

function indentBlock(text) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(text));
  if (!normalized) {
    return "";
  }
  return normalized.split("\n").map((line) => `    ${line}`).join("\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
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

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function sanitizeReplyText(plainReplyText) {
  const normalized = normalizeLineEndings(String(plainReplyText || ""));
  if (!normalized) {
    return "";
  }
  const protocolSanitized = sanitizeProtocolLeakText(normalized);
  return sanitizeOperationalLeakText(protocolSanitized.text || "");
}

function sanitizeOperationalLeakText(text) {
  const normalized = normalizeLineEndings(String(text || ""));
  if (!normalized) {
    return "";
  }
  const lines = normalized.split("\n");
  const kept = [];
  for (const line of lines) {
    if (isOperationalLeakLine(line)) {
      continue;
    }
    const cleaned = stripFictionalToneLeak(line);
    if (cleaned.trim()) {
      kept.push(cleaned);
    }
  }
  return trimOuterBlankLines(kept.join("\n").replace(/\n{3,}/g, "\n\n"));
}

function isOperationalLeakLine(line) {
  const normalized = String(line || "").trim();
  if (!normalized) {
    return false;
  }
  return OPERATIONAL_LEAK_PATTERNS.some((pattern) => pattern.test(normalized));
}

const OPERATIONAL_LEAK_PATTERNS = [
  /^我(?:先|会|来)?把.{0,12}(?:状态|情绪|这段|这条).{0,8}(?:接住|接稳|稳住|收住)/,
  /(?:再|然后)(?:判断|看看|决定).{0,8}(?:要不要|是否).{0,16}(?:提醒|记录|写|留|收尾)/,
  /^我(?:先|会)?在后台/,
  /^我(?:先|会|来|去|再|马上)?把.*(?:时间轴|timeline|日历|calendar|Obsidian|日记|分类|category|记录|数据|班表).*(?:看一下|查一下|处理|整理|接进去|接上|写进去|补进去|更新|同步|分类|归类|记(?:一下|成|进|到)?)/i,
  /^我(?:先|会|来|去|再|马上)?(?:看一下|查一下|处理|整理|更新|同步|读取|检查).*(?:时间轴|timeline|日历|calendar|Obsidian|日记|分类|category|记录|数据|班表)/i,
  /^我(?:先|会|来|去|再|马上)?把.*(?:状态|收尾|夜班|下班|这条|这个).*(?:接住|接上|补到|补进|放进|写进|记成|记进).*(?:记录|日记|时间线|timeline|可用记录|今天)/i,
  /^我(?:再|先|来|会|马上)?看一眼.*(?:时间线|timeline|记录|日记|今天).*(?:避免重复|重复写|顺手|补|放进|接进去|接上)/i,
  /^我把.*(?:收尾|状态|这条|这个).*(?:记成|记为|补成|放进|写进).*(?:可用记录|记录|日记|时间线|timeline)/i,
  /^这段(?:先|会|可以)?(?:记成|记为|归类为|分类为|接进|接到|写进|放进).*(?:时间轴|timeline|日记|Obsidian|低脑力整理块|记录|分类|category)?/i,
  /(?:顺手|先|再).*(?:补到|补进|放进|写进|接进|接到).*(?:今天|记录|日记|时间线|timeline)/i,
  /(?:不让它丢|避免重复写|可用记录|记录层|后台处理|工具处理)/i,
  /^先(?:把|看|查|处理|整理|更新).*(?:时间轴|timeline|日历|calendar|Obsidian|日记|分类|category|记录|数据|班表)/i,
  /(?:后台|内部|tool|pipeline|数据层|记录层|工具调用|工具结果).*(?:处理|记录|分类|更新|同步|写入|执行)/i,
];

function stripFictionalToneLeak(line) {
  let cleaned = String(line || "");
  cleaned = cleaned.replace(/^\s*[（(][^）)]*(?:轻轻一笑|笑了笑|声音放轻|语气温柔|带着暖意|宠溺|低语|哄人入睡|揉揉头|摸摸头|看着你)[^）)]*[）)]\s*/g, "");
  cleaned = cleaned.replace(/[（(][^）)]*(?:轻轻一笑|笑了笑|声音放轻|语气温柔|带着暖意|宠溺|低语|哄人入睡|揉揉头|摸摸头|看着你)[^）)]*[）)]/g, "");
  cleaned = cleaned.replace(/^\s*(?:语气|声音|神情|眼神)[^，。！？\n]*(?:温柔|放轻|宠溺|低语|暖意|哄人入睡)[^，。！？\n]*[，。！？]?\s*/g, "");
  cleaned = cleaned.replace(/(?:我看着你慢慢合上眼|眼睛就开始打架了|毛孩子们在旁边守着，我也在。?)/g, "");
  cleaned = cleaned.replace(/(?:小傻瓜|乖乖睡|乖乖休息|乖，)/g, "");
  cleaned = cleaned.replace(/^[，,]\s*/g, "");
  cleaned = cleaned.replace(/，\s*([。！？])/g, "$1");
  cleaned = cleaned.replace(/你，/g, "你");
  return cleaned;
}

function resolveSystemReplyDelivery(replyText, policy = createSystemReplyPolicy("")) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return { kind: "invalid", reason: "final reply is empty" };
  }

  const source = normalizeSystemReplySource(normalized);
  if (source.requiresStructuredAction || source.text.startsWith("{")) {
    return resolveSystemReplyAction(source.text);
  }
  const embeddedCandidate = extractSystemActionJsonCandidate(source.text);
  if (embeddedCandidate) {
    return resolveSystemReplyAction(embeddedCandidate);
  }

  if (!policy.allowPlainTextSendMessage) {
    return { kind: "invalid", reason: "final reply is not a JSON object" };
  }

  return resolvePlainTextSystemReply(source.text, policy);
}

function resolveSystemReplyAction(candidate) {
  const parsed = tryParseJson(candidate);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return { kind: "invalid", reason: "final reply is not a JSON object" };
  }

  const action = normalizeSystemActionName(parsed.action || parsed.cyberboss_action);
  if (action === "silent") {
    return { kind: "silent" };
  }
  if (action !== "send_message") {
    return { kind: "invalid", reason: "unsupported action" };
  }

  const message = sanitizeProtocolLeakText(normalizeLineEndings(String(parsed.message || parsed.text || ""))).text.trim();
  if (!message) {
    return { kind: "invalid", reason: "send_message requires a non-empty message" };
  }

  return { kind: "send_message", message };
}

function normalizeSystemReplySource(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  const unfenced = unwrapJsonCodeFence(normalized);
  if (unfenced) {
    return {
      text: unfenced.replace(/^json\s*:\s*/i, "").trim(),
      requiresStructuredAction: true,
    };
  }
  const strippedJsonPrefix = normalized.replace(/^json\s*:\s*/i, "").trim();
  return {
    text: strippedJsonPrefix,
    requiresStructuredAction: strippedJsonPrefix !== normalized,
  };
}

function resolvePlainTextSystemReply(replyText, policy) {
  const message = sanitizePlainTextSystemReply(replyText, policy);
  if (!message) {
    return { kind: "invalid", reason: "plain text system reply is unsafe" };
  }
  return { kind: "send_message", message };
}

function sanitizePlainTextSystemReply(replyText, policy) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (!normalized) {
    return "";
  }
  if (normalized.length > policy.maxPlainTextLength) {
    return "";
  }
  if (normalized.split("\n").length > policy.maxPlainTextLines) {
    return "";
  }
  if (containsPlainTextSystemHazard(normalized)) {
    return "";
  }
  return sanitizeReplyText(normalized);
}

function containsPlainTextSystemHazard(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized) {
    return true;
  }
  return /```/.test(normalized)
    || /^\s*[\[{]/.test(normalized)
    || /(?:^|\n)\s*(?:analysis|commentary|final)\s+to=/i.test(normalized)
    || /\b(?:tool_use|tool_result|function_call|mcp__|exec_command|apply_patch|read_mcp_resource)\b/i.test(normalized)
    || /(?:^|\n)\s*(?:\{|\[).*"(?:action|cyberboss_action|tool|toolName|tool_name)"\s*:/i.test(normalized);
}

function createSystemReplyPolicy(runtimeId) {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  /*
   * System/check-in turns are intentionally stricter than normal WeChat replies.
   * The stable protocol is one JSON action object: {"action":"silent"} or
   * {"action":"send_message","message":"..."}. JSON may be wrapped in a pure
   * ```json fence or prefixed with "json:" because those are presentation
   * wrappers around the same object, not alternate meanings.
   *
   * Codex must stay JSON-only: its streaming item protocol has historically been
   * able to expose tool/protocol fragments as assistant text, so plain system
   * text is not trusted. Claude Code is different in this bridge: tool use,
   * thinking, and assistant text are non-deliverable events, and WeChat receives
   * only the final result event. For claudecode only, a short natural final text
   * with no code fence, JSON/action fragment, tool marker, or protocol marker is
   * treated as send_message so random check-ins do not disappear when the model
   * forgets the JSON wrapper.
   */
  return {
    runtimeId: normalizedRuntimeId,
    allowPlainTextSendMessage: normalizedRuntimeId === "claudecode",
    maxPlainTextLength: 280,
    maxPlainTextLines: 3,
  };
}

function classifyReplyItemSourceText(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return null;
  }
  const unfenced = unwrapJsonCodeFence(normalized) || normalized;
  const stripped = unfenced.replace(/^json\s*:\s*/i, "").trim();
  const candidate = extractSystemActionJsonCandidate(stripped) || (stripped.startsWith("{") ? stripped : "");
  if (!candidate) {
    return null;
  }
  if (candidate !== stripped) {
    return null;
  }
  return resolveSystemReplyAction(candidate);
}

function unwrapJsonCodeFence(text) {
  const match = String(text || "").trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? String(match[1] || "").trim() : "";
}

function buildActionDelivery(itemId, sourceText, action) {
  if (!action || typeof action !== "object") {
    return null;
  }
  if (action.kind === "silent") {
    return { itemId, kind: "silent", sourceText };
  }
  if (action.kind === "send_message") {
    return { itemId, kind: "action", sourceText, message: action.message };
  }
  return {
    itemId,
    kind: "invalid_action",
    sourceText,
    reason: action.reason || "invalid structured action",
  };
}

function buildDeliveryPreviewText(delivery) {
  if (!delivery || typeof delivery !== "object") {
    return "";
  }
  if (delivery.kind === "action") {
    return delivery.message || "";
  }
  if (delivery.kind === "plain") {
    return delivery.text || "";
  }
  return "";
}

function normalizeSystemActionName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function normalizeRuntimeId(value) {
  return String(value || "").trim().toLowerCase();
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractSystemActionJsonCandidate(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized || !normalized.endsWith("}")) {
    return "";
  }
  if (normalized.startsWith("{")) {
    return normalized;
  }
  for (let index = normalized.lastIndexOf("{"); index >= 0; index = normalized.lastIndexOf("{", index - 1)) {
    const candidate = normalized.slice(index).trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    const parsed = tryParseJson(candidate);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      continue;
    }
    if ("action" in parsed || "cyberboss_action" in parsed) {
      return candidate;
    }
  }
  return "";
}

function isSystemReplyContextFailure(error) {
  const message = String(error?.message || "");
  const ret = normalizeNumericErrorCode(error?.ret);
  const errcode = normalizeNumericErrorCode(error?.errcode);
  return ret === -2
    || errcode === -2
    || message.includes("sendMessage ret=-2")
    || message.includes("errcode=-2");
}

function normalizeNumericErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

module.exports = { StreamDelivery };
