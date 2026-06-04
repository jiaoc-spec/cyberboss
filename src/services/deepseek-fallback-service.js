class DeepSeekFallbackService {
  constructor({ config, fetchImpl = globalThis.fetch } = {}) {
    this.config = config || {};
    this.fetchImpl = fetchImpl;
  }

  isEnabled() {
    return this.config.deepseekFallbackEnabled === true
      && Boolean(normalizeText(this.config.deepseekApiKey))
      && typeof this.fetchImpl === "function";
  }

  async generate({ userText = "", reason = "", provider = "", systemMessage = false } = {}) {
    if (!this.isEnabled()) {
      return { text: "", used: false, reason: "disabled" };
    }
    const prompt = normalizeText(userText);
    if (!prompt) {
      return { text: "", used: false, reason: "empty_prompt" };
    }

    const controller = new AbortController();
    const timeoutMs = Number(this.config.deepseekTimeoutMs) || 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.deepseekApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.deepseekModel || "deepseek-v4-flash",
          messages: [
            {
              role: "system",
              content: buildFallbackSystemPrompt(this.config, {
                reason,
                provider,
                systemMessage,
              }),
            },
            { role: "user", content: prompt },
          ],
          stream: false,
          temperature: 0.4,
          max_tokens: Number(this.config.deepseekMaxOutputTokens) || 1200,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(`DeepSeek HTTP ${response.status}: ${extractApiError(payload) || response.statusText}`);
      }
      const text = normalizeText(payload?.choices?.[0]?.message?.content);
      if (!text) {
        throw new Error("DeepSeek returned an empty response.");
      }
      return {
        text,
        used: true,
        model: normalizeText(payload?.model) || this.config.deepseekModel || "deepseek-v4-flash",
        usage: normalizeUsage(payload?.usage),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  apiBaseUrl() {
    return normalizeText(this.config.deepseekApiBaseUrl).replace(/\/+$/, "") || "https://api.deepseek.com";
  }
}

function buildFallbackSystemPrompt(config, { reason = "", provider = "", systemMessage = false } = {}) {
  const userName = normalizeText(config.userName) || "User";
  return [
    `You are the emergency fallback model for CyberBoss, ${userName}'s personal assistant.`,
    "The primary Codex model could not produce a usable reply. Continue the conversation naturally without mentioning internal model limits unless the user asked about them.",
    "Be concise, warm, factual, shame-aware, and respect the user's chosen priorities. Help with the smallest useful next step when she is stuck. Never shame, supervise, invent a fixed order, or pressure her.",
    "CyberBoss protects long-term values rather than maximizing productivity. Priority awareness means gently reminding her of what she already chose while leaving the choice with her.",
    "Do not claim that you executed tools, wrote files, read calendars, updated Obsidian, changed reminders, or know facts that are not present in the prompt.",
    "If the request requires local tools or unavailable data, say that the message is received and that the tool action needs to be retried when the primary model is available.",
    systemMessage
      ? "This is a proactive system trigger. Reply with exactly one JSON object: {\"action\":\"send_message\",\"message\":\"...\"} or {\"action\":\"silent\"}."
      : "Reply directly to the user in the language they used.",
    reason ? `Fallback reason: ${normalizeText(reason)}` : "",
    provider ? `Channel provider: ${normalizeText(provider)}` : "",
  ].filter(Boolean).join("\n\n");
}

function extractApiError(payload) {
  return normalizeText(payload?.error?.message || payload?.message);
}

function normalizeUsage(usage) {
  return {
    inputTokens: numberOrZero(usage?.prompt_tokens),
    outputTokens: numberOrZero(usage?.completion_tokens),
    totalTokens: numberOrZero(usage?.total_tokens),
  };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DeepSeekFallbackService,
  buildFallbackSystemPrompt,
};
