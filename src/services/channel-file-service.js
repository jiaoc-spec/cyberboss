const fs = require("fs");
const path = require("path");

const { resolvePreferredSenderId } = require("../core/default-targets");

class ChannelFileService {
  constructor({ config, channelAdapter, sessionStore }) {
    this.config = config;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
  }

  async sendToCurrentChat({ filePath = "", userId = "" } = {}, context = {}) {
    const account = this.channelAdapter.resolveAccount();
    const contextTokens = typeof this.channelAdapter.getKnownContextTokens === "function"
      ? this.channelAdapter.getKnownContextTokens()
      : {};
    const targetUserId = normalizeText(userId)
      || normalizeText(context?.senderId)
      || resolvePreferredSenderId({
        config: this.config,
        accountId: account.accountId,
        sessionStore: this.sessionStore,
        contextTokens,
      });
    if (!targetUserId) {
      throw new Error("Cannot determine which channel user should receive the file.");
    }

    const contextToken = String(contextTokens[targetUserId] || "").trim();
    if (!contextToken) {
      throw new Error(`Cannot find a context token for user ${targetUserId}. Let this user talk to the bot once first.`);
    }

    const requestedPath = normalizeText(filePath);
    if (!requestedPath) {
      throw new Error("Missing file path to send.");
    }
    const resolvedPath = path.resolve(requestedPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: ${resolvedPath}`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Only files can be sent, not directories: ${resolvedPath}`);
    }

    await this.channelAdapter.sendTyping({
      userId: targetUserId,
      status: 1,
      contextToken,
    }).catch(() => {});
    await this.channelAdapter.sendFile({
      userId: targetUserId,
      filePath: resolvedPath,
      contextToken,
    });
    await this.channelAdapter.sendTyping({
      userId: targetUserId,
      status: 0,
      contextToken,
    }).catch(() => {});
    return { userId: targetUserId, filePath: resolvedPath };
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ChannelFileService };
