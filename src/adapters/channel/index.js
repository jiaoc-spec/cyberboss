const { createTelegramChannelAdapter } = require("./telegram");
const { createWeixinChannelAdapter } = require("./weixin");

function createChannelAdapter(config) {
  const channel = String(config?.channel || "weixin").trim().toLowerCase();
  if (channel === "telegram") {
    return createTelegramChannelAdapter(config);
  }
  if (channel === "weixin") {
    return createWeixinChannelAdapter(config);
  }
  throw new Error(`Unsupported channel: ${channel}`);
}

module.exports = { createChannelAdapter };
