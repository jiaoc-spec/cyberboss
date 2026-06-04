const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { mapCodexMessageToRuntimeEvent } = require("../src/adapters/runtime/codex/events");
const { UsageStore, estimateCostUsd } = require("../src/core/usage-store");

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-usage-test-"));
  return new UsageStore({
    filePath: path.join(dir, "usage.json"),
    timeZone: "Europe/Berlin",
    pricing: { blendedUsdPer1M: 2 },
  });
}

test("Codex thread token usage notifications map to runtime context events", () => {
  const event = mapCodexMessageToRuntimeEvent({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: 36088,
          inputTokens: 36083,
          cachedInputTokens: 26496,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 36088,
          inputTokens: 36083,
          cachedInputTokens: 26496,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 258400,
      },
    },
  });

  assert.equal(event.type, "runtime.context.updated");
  assert.equal(event.payload.threadId, "thread-1");
  assert.equal(event.payload.turnId, "turn-1");
  assert.equal(event.payload.currentTokens, 36088);
  assert.equal(event.payload.turnUsage.cachedInputTokens, 26496);
});

test("UsageStore records per-turn usage once", () => {
  const store = createStore();
  const context = {
    runtimeId: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    currentTokens: 36088,
    turnUsage: {
      totalTokens: 36088,
      inputTokens: 36083,
      cachedInputTokens: 26496,
      outputTokens: 5,
      reasoningTokens: 0,
    },
  };

  assert.ok(store.recordRuntimeContext(context));
  assert.equal(store.recordRuntimeContext(context), null);
  const summary = store.summarize();
  assert.equal(summary.hasRecordedUsage, true);
  assert.equal(summary.today.totalTokens, 36088);
  assert.equal(summary.today.cachedInputTokens, 26496);
});

test("itemized pricing does not double-charge cached input tokens", () => {
  const cost = estimateCostUsd({
    inputTokens: 1000,
    cachedInputTokens: 600,
    outputTokens: 100,
    totalTokens: 1100,
  }, {
    inputUsdPer1M: 10,
    cachedInputUsdPer1M: 1,
    outputUsdPer1M: 20,
  });

  assert.equal(cost, 0.0066);
});
