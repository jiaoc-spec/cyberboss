const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_TELEGRAM_TEXT = 4096;
const LONG_POLL_TIMEOUT_SECONDS = 35;

function createTelegramChannelAdapter(config) {
  let account = null;
  let knownContextTokens = {};

  function ensureAccount() {
    if (!account) {
      account = loadTelegramAccount(config);
      knownContextTokens = loadTelegramContextTokens(config, account.accountId);
    }
    return account;
  }

  function rememberChat(chatId) {
    const resolvedAccount = ensureAccount();
    const id = normalizeText(chatId);
    if (!id) {
      return "";
    }
    knownContextTokens = saveTelegramContextTokens(config, resolvedAccount.accountId, {
      ...knownContextTokens,
      [id]: id,
    });
    return id;
  }

  return {
    describe() {
      return {
        id: "telegram",
        kind: "channel",
        stateDir: config.stateDir,
        baseUrl: config.telegramApiBaseUrl,
        accountsDir: config.accountsDir,
        syncFile: config.telegramSyncFile,
      };
    },
    async login() {
      const nextAccount = await resolveTelegramAccountFromToken(config);
      saveTelegramAccount(config, nextAccount);
      account = nextAccount;
      knownContextTokens = loadTelegramContextTokens(config, account.accountId);
      console.log(`Telegram bot connected: @${nextAccount.username || nextAccount.accountId}`);
      console.log(`accountId: ${nextAccount.accountId}`);
      if (!config.telegramAllowedChatIds.length) {
        console.log("No TELEGRAM_ALLOWED_CHAT_IDS configured yet. Send /status to the bot once, then set the chat id shown in logs if needed.");
      }
    },
    printAccounts() {
      const accounts = listTelegramAccounts(config);
      if (!accounts.length) {
        console.log("No saved Telegram bot found. Set TELEGRAM_BOT_TOKEN and run `npm run login`.");
        return;
      }
      console.log("Saved Telegram bots:");
      for (const item of accounts) {
        console.log(`- ${item.accountId}`);
        console.log(`  username: ${item.username || "(unknown)"}`);
        console.log(`  savedAt: ${item.savedAt || "(unknown)"}`);
      }
    },
    resolveAccount() {
      return ensureAccount();
    },
    getKnownContextTokens() {
      return { ...knownContextTokens };
    },
    loadSyncBuffer() {
      return String(loadTelegramOffset(config) || "");
    },
    saveSyncBuffer(offset) {
      saveTelegramOffset(config, offset);
    },
    rememberContextToken(userId, contextToken) {
      return rememberChat(contextToken || userId);
    },
    async getUpdates({ syncBuffer = "", timeoutMs = LONG_POLL_TIMEOUT_SECONDS * 1000 } = {}) {
      const resolvedAccount = ensureAccount();
      const offset = Number.parseInt(String(syncBuffer || loadTelegramOffset(config) || "0"), 10) || 0;
      const timeout = Math.max(1, Math.round(Number(timeoutMs || 0) / 1000));
      const updates = await telegramApi(resolvedAccount.token, "getUpdates", {
        offset: offset || undefined,
        timeout,
        allowed_updates: ["message", "edited_message"],
      }, config);
      const result = Array.isArray(updates?.result) ? updates.result : [];
      const nextOffset = result.reduce((max, update) => Math.max(max, Number(update?.update_id || 0) + 1), offset);
      if (nextOffset && nextOffset !== offset) {
        this.saveSyncBuffer(String(nextOffset));
      }
      const messages = [];
      for (const update of result) {
        const enriched = await enrichTelegramUpdate(resolvedAccount.token, update, config);
        if (enriched) {
          const chatId = normalizeText(resolveTelegramChatId(enriched));
          if (chatId) {
            rememberChat(chatId);
          }
          messages.push(enriched);
        }
      }
      return { ret: 0, msgs: messages, get_updates_buf: String(nextOffset || offset || "") };
    },
    normalizeIncomingMessage(update) {
      return normalizeTelegramIncoming(update, config, ensureAccount().accountId);
    },
    async sendText({ userId, text, preserveBlock = false }) {
      const resolvedAccount = ensureAccount();
      const chatId = normalizeText(userId);
      if (!chatId) {
        throw new Error("telegram sendText requires chat id");
      }
      const chunks = splitTelegramText(text || "Completed.", preserveBlock ? MAX_TELEGRAM_TEXT : 3500);
      for (const chunk of chunks) {
        await telegramApi(resolvedAccount.token, "sendMessage", {
          chat_id: chatId,
          text: chunk || "Completed.",
          disable_web_page_preview: true,
        }, config);
      }
    },
    async sendTyping({ userId, status = 1 }) {
      if (!status) {
        return;
      }
      const resolvedAccount = ensureAccount();
      const chatId = normalizeText(userId);
      if (!chatId) {
        return;
      }
      await telegramApi(resolvedAccount.token, "sendChatAction", {
        chat_id: chatId,
        action: "typing",
      }, config).catch(() => {});
    },
    async sendFile({ userId, filePath }) {
      const resolvedAccount = ensureAccount();
      const chatId = normalizeText(userId);
      if (!chatId) {
        throw new Error("telegram sendFile requires chat id");
      }
      await sendTelegramFile({
        token: resolvedAccount.token,
        chatId,
        filePath,
        config,
      });
    },
    setMinChunkChars(value) {
      const parsed = Number.parseInt(String(value), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_TELEGRAM_TEXT) {
        config.telegramMinChunkChars = parsed;
      }
      return config.telegramMinChunkChars || 20;
    },
    getMinChunkChars() {
      return config.telegramMinChunkChars || 20;
    },
  };
}

function normalizeTelegramIncoming(update, config, accountId) {
  const message = update?.message || update?.edited_message || null;
  if (!message || !message.chat) {
    return null;
  }
  if (message.from?.is_bot) {
    return null;
  }
  const chatId = normalizeText(message.chat.id);
  if (!chatId) {
    return null;
  }
  if (config.telegramAllowedChatIds.length && !config.telegramAllowedChatIds.includes(chatId)) {
    return null;
  }
  const text = normalizeText(message.text || message.caption);
  const attachments = Array.isArray(update.__cyberbossAttachments) ? update.__cyberbossAttachments : [];
  if (!text && !attachments.length) {
    return null;
  }
  return {
    provider: "telegram",
    accountId,
    workspaceId: config.workspaceId,
    senderId: chatId,
    chatId,
    messageId: normalizeText(message.message_id),
    threadKey: chatId,
    text,
    attachments,
    contextToken: chatId,
    receivedAt: message.date ? new Date(Number(message.date) * 1000).toISOString() : new Date().toISOString(),
  };
}

async function enrichTelegramUpdate(token, update, config) {
  const message = update?.message || update?.edited_message || null;
  if (!message) {
    return update;
  }
  const attachments = [];
  const photo = Array.isArray(message.photo) && message.photo.length
    ? message.photo[message.photo.length - 1]
    : null;
  if (photo?.file_id) {
    attachments.push(await buildTelegramAttachment(token, photo.file_id, {
      kind: "image",
      fileName: `telegram-photo-${message.message_id || Date.now()}.jpg`,
      sizeBytes: photo.file_size,
    }, config));
  }
  if (message.document?.file_id) {
    attachments.push(await buildTelegramAttachment(token, message.document.file_id, {
      kind: "file",
      fileName: message.document.file_name,
      sizeBytes: message.document.file_size,
    }, config));
  }
  if (message.video?.file_id) {
    attachments.push(await buildTelegramAttachment(token, message.video.file_id, {
      kind: "video",
      fileName: message.video.file_name || `telegram-video-${message.message_id || Date.now()}.mp4`,
      sizeBytes: message.video.file_size,
    }, config));
  }
  return { ...update, __cyberbossAttachments: attachments.filter(Boolean) };
}

async function buildTelegramAttachment(token, fileId, base, config) {
  const file = await telegramApi(token, "getFile", { file_id: fileId }, config).catch(() => null);
  const filePath = normalizeText(file?.result?.file_path);
  const directUrl = filePath ? `${config.telegramFileBaseUrl}/file/bot${token}/${filePath}` : "";
  return {
    kind: base.kind || "file",
    itemType: 0,
    index: 0,
    fileName: normalizeText(base.fileName),
    sizeBytes: Number(base.sizeBytes) || 0,
    directUrls: directUrl ? [directUrl] : [],
    mediaRef: {},
    rawItem: { telegramFileId: fileId, telegramFilePath: filePath },
  };
}

async function resolveTelegramAccountFromToken(config) {
  if (!config.telegramBotToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN. Create a bot with @BotFather and set TELEGRAM_BOT_TOKEN.");
  }
  const response = await telegramApi(config.telegramBotToken, "getMe", {}, config);
  const bot = response?.result || {};
  if (!bot.id) {
    throw new Error("Telegram getMe did not return a bot id");
  }
  return {
    accountId: `telegram-${bot.id}`,
    rawAccountId: String(bot.id),
    token: config.telegramBotToken,
    username: normalizeText(bot.username),
    userId: String(bot.id),
    savedAt: new Date().toISOString(),
  };
}

async function telegramApi(token, method, payload = {}, config, attempt = 0) {
  const url = `${config.telegramApiBaseUrl}/bot${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    const retryAfterSeconds = Number(data?.parameters?.retry_after);
    if (response.status === 429 && Number.isFinite(retryAfterSeconds) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfterSeconds, 60) * 1000));
      return telegramApi(token, method, payload, config, attempt + 1);
    }
    throw new Error(`telegram ${method} failed: ${data?.description || response.statusText}`);
  }
  return data;
}

async function sendTelegramFile({ token, chatId, filePath, config }) {
  const resolvedPath = path.resolve(filePath);
  const bytes = fs.readFileSync(resolvedPath);
  const fileName = path.basename(resolvedPath);
  const isImage = /\.(png|jpe?g|webp|gif)$/i.test(fileName);
  const fieldName = isImage ? "photo" : "document";
  const method = isImage ? "sendPhoto" : "sendDocument";
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append(fieldName, new Blob([bytes]), fileName);
  const response = await fetch(`${config.telegramApiBaseUrl}/bot${token}/${method}`, {
    method: "POST",
    body: form,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    throw new Error(`telegram ${method} failed: ${data?.description || response.statusText}`);
  }
  return data;
}

function loadTelegramAccount(config) {
  const accounts = listTelegramAccounts(config);
  if (config.accountId) {
    const found = accounts.find((item) => item.accountId === config.accountId);
    if (!found) {
      throw new Error(`Telegram bot account not found: ${config.accountId}`);
    }
    return found;
  }
  if (accounts.length) {
    return accounts[0];
  }
  if (config.telegramBotToken) {
    const accountId = `telegram-${hashToken(config.telegramBotToken)}`;
    return {
      accountId,
      rawAccountId: accountId,
      token: config.telegramBotToken,
      username: "",
      userId: accountId,
      savedAt: "",
    };
  }
  throw new Error("No Telegram bot configured. Set TELEGRAM_BOT_TOKEN and run `npm run login`.");
}

function listTelegramAccounts(config) {
  ensureAccountsDir(config);
  return fs.readdirSync(config.accountsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("telegram-") && entry.name.endsWith(".json"))
    .map((entry) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(config.accountsDir, entry.name), "utf8"));
        return {
          accountId: normalizeText(parsed.accountId),
          rawAccountId: normalizeText(parsed.rawAccountId),
          token: normalizeText(parsed.token),
          username: normalizeText(parsed.username),
          userId: normalizeText(parsed.userId),
          savedAt: normalizeText(parsed.savedAt),
        };
      } catch {
        return null;
      }
    })
    .filter((item) => item?.accountId && item?.token)
    .sort((left, right) => String(right.savedAt || "").localeCompare(String(left.savedAt || "")));
}

function saveTelegramAccount(config, account) {
  ensureAccountsDir(config);
  const filePath = path.join(config.accountsDir, `${account.accountId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(account, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
}

function loadTelegramContextTokens(config, accountId) {
  try {
    const filePath = telegramContextTokenFile(config, accountId);
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveTelegramContextTokens(config, accountId, tokens) {
  const filePath = telegramContextTokenFile(config, accountId);
  ensureAccountsDir(config);
  fs.writeFileSync(filePath, JSON.stringify(tokens || {}, null, 2), "utf8");
  return tokens || {};
}

function telegramContextTokenFile(config, accountId) {
  return path.join(config.accountsDir, `${accountId}.context-tokens.json`);
}

function loadTelegramOffset(config) {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.telegramSyncFile, "utf8"));
    return normalizeText(parsed.offset);
  } catch {
    return "";
  }
}

function saveTelegramOffset(config, offset) {
  fs.mkdirSync(path.dirname(config.telegramSyncFile), { recursive: true });
  fs.writeFileSync(config.telegramSyncFile, JSON.stringify({ offset: normalizeText(offset) }, null, 2), "utf8");
}

function ensureAccountsDir(config) {
  fs.mkdirSync(config.accountsDir, { recursive: true });
}

function resolveTelegramChatId(update) {
  const message = update?.message || update?.edited_message || null;
  return message?.chat?.id;
}

function splitTelegramText(text, limit) {
  const runes = Array.from(String(text || ""));
  if (!runes.length) {
    return ["Completed."];
  }
  const chunks = [];
  while (runes.length) {
    chunks.push(runes.splice(0, limit).join(""));
  }
  return chunks;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex").slice(0, 12);
}

function normalizeText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

module.exports = { createTelegramChannelAdapter };
