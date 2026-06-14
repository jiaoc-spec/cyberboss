const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DecisionJournalState } = require("../src/core/decision-journal-state");
const { WinsLedgerState } = require("../src/core/wins-ledger-state");
const { AssistantCommandCenter, ContextEngineService, extractAnswerText } = require("../src/services/context-engine-service");
const { CurrentStateService } = require("../src/services/current-state-service");

function makeConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-context-engine-"));
  return {
    timeZone: "Europe/Berlin",
    diaryTimeZone: "Europe/Berlin",
    shiftRatingStateFile: path.join(dir, "shift-rating-state.json"),
    missingContextStateFile: path.join(dir, "missing-context-state.json"),
    digestionStateFile: path.join(dir, "digestion-state.json"),
    currentStateFile: path.join(dir, "current-state.json"),
  };
}

test("latest matching pending question wins over older numeric prompts", async () => {
  const config = makeConfig();
  fs.writeFileSync(config.shiftRatingStateFile, `${JSON.stringify({
    lastPromptBySender: {
      "telegram:jane": {
        promptedAt: "2026-06-13T15:00:00.000Z",
        answeredAt: "",
        text: "下班啦",
      },
    },
  })}\n`);
  const wins = new WinsLedgerState();
  wins.setPending("jane", {
    task: "Englisch",
    domain: "learning",
    date: "2026-06-13",
    promptedAt: "2026-06-13T15:40:00.000Z",
  });

  const context = await new ContextEngineService({ config, services: {} }).analyzeIncoming({
    normalized: {
      provider: "telegram",
      senderId: "jane",
      text: "3",
      receivedAt: "2026-06-13T15:41:00.000Z",
    },
    winsLedgerState: wins,
  });

  assert.equal(context.pendingReply.target, "wins_ledger");
  assert.equal(new AssistantCommandCenter({ config }).decideIncoming(context).pendingReplyTarget, "wins_ledger");
});

test("quoted replies use the actual answer line for pending context questions", async () => {
  const config = makeConfig();
  fs.writeFileSync(config.missingContextStateFile, `${JSON.stringify({
    days: {
      "2026-06-13": {
        questions: [{
          id: "q1",
          senderKey: "telegram:jane",
          status: "prompted",
          field: "reason_for_missing_level_a",
          title: "Level A 未完成原因",
          promptedAt: "2026-06-13T15:30:00.000Z",
          options: [
            { key: "1", label: "太累", value: "fatigue" },
            { key: "2", label: "没时间", value: "time" },
            { key: "3", label: "忘记", value: "forgot" },
          ],
        }],
      },
    },
  })}\n`);

  const text = "[Quoted: 今天没运动主要是因为：1. 太累 2. 没时间 3. 忘记]\n3";
  assert.equal(extractAnswerText(text), "3");

  const context = await new ContextEngineService({ config, services: {} }).analyzeIncoming({
    normalized: {
      provider: "telegram",
      senderId: "jane",
      text,
      receivedAt: "2026-06-13T17:41:00.000Z",
    },
  });

  assert.equal(context.answerText, "3");
  assert.equal(context.pendingReply.target, "missing_context");
});

test("current work state creates hard guardrails and keeps routing on Codex", async () => {
  const config = makeConfig();
  const currentState = new CurrentStateService({ config });
  currentState.observeMessage({
    text: "今日 05:17 出发上的早班",
    receivedAt: "2026-06-14T09:33:00+02:00",
    provider: "telegram",
    senderId: "jane",
  });

  const engine = new ContextEngineService({ config, services: { currentState } });
  const context = await engine.analyzeIncoming({
    normalized: {
      provider: "telegram",
      senderId: "jane",
      text: "今天好累",
      receivedAt: "2026-06-14T10:00:00+02:00",
    },
  });
  const decision = new AssistantCommandCenter({ config }).decideIncoming(context);

  assert.equal(context.current.current.state, "at_work");
  assert.equal(decision.requiresCodex, true);
  assert.ok(decision.guardLines.some((line) => /home-only action/.test(line)));
  assert.ok(decision.riskReasons.includes("protection:busy_at_work"));
});

test("decision journal confirmation is recognized as a pending reply", async () => {
  const config = makeConfig();
  const decisionState = new DecisionJournalState();
  decisionState.setPending("jane", {
    text: "我决定先观察 DeepSeek fallback",
    date: "2026-06-13",
    promptedAt: "2026-06-13T12:00:00.000Z",
  });

  const context = await new ContextEngineService({ config, services: {} }).analyzeIncoming({
    normalized: {
      provider: "telegram",
      senderId: "jane",
      text: "记录",
      receivedAt: "2026-06-13T12:01:00.000Z",
    },
    decisionJournalState: decisionState,
  });

  assert.equal(context.pendingReply.target, "decision_journal");
});
