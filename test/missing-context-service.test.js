const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MissingContextService,
  parseAnswer,
} = require("../src/services/missing-context-service");

function createService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-missing-context-"));
  const sent = [];
  const config = {
    userName: "Jane",
    timeZone: "Europe/Berlin",
    workspaceRoot: "/workspace",
    missingContextEnabled: true,
    missingContextStateFile: path.join(dir, "missing-context-state.json"),
    missingContextCheckIntervalMs: 1,
    missingContextDailyMaxQuestions: 3,
    missingContextFirstPromptHour: 12,
    shiftRatingStateFile: path.join(dir, "shift-rating-state.json"),
    ...overrides.config,
  };
  const service = new MissingContextService({
    config,
    dailyState: overrides.dailyState || {
      async analyze() {
        return {
          signals: {},
          priorityTiming: { isDue: true },
          levelA: [
            { id: "sport", label: "Sport", completed: false },
            { id: "english", label: "Englisch", completed: true },
            { id: "german", label: "Deutsch", completed: false },
          ],
        };
      },
    },
    channelAdapter: {
      describe() {
        return { id: "telegram" };
      },
      getKnownContextTokens() {
        return { jane: "ctx" };
      },
      async sendText(payload) {
        sent.push(payload);
      },
    },
    sessionStore: {
      buildBindingKey() {
        return "binding";
      },
      getActiveWorkspaceRoot() {
        return "/workspace";
      },
      getBinding() {
        return null;
      },
      state: { bindings: {} },
    },
  });
  return { service, sent, config };
}

test("missing context asks one high-value Level A reason question", async () => {
  const { service, sent, config } = createService();

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-06T20:05:00+02:00"));

  assert.equal(result.prompted.length, 1);
  assert.equal(result.prompted[0].field, "reason_for_missing_level_a");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Sport、Deutsch/);
  assert.match(sent[0].text, /你可以只回数字/);
  const state = JSON.parse(fs.readFileSync(config.missingContextStateFile, "utf8"));
  assert.equal(state.days["2026-06-06"].questions.length, 1);
});

test("numeric answer is captured as structured evidence and acknowledged", async () => {
  const { service, sent, config } = createService();
  await service.check({ accountId: "account-1" }, new Date("2026-06-06T20:05:00+02:00"));

  const result = await service.observeIncoming({
    provider: "telegram",
    senderId: "jane",
    contextToken: "ctx",
    text: "1",
    receivedAt: "2026-06-06T20:06:00+02:00",
  });

  assert.equal(result.handled, true);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /太累/);
  const state = JSON.parse(fs.readFileSync(config.missingContextStateFile, "utf8"));
  assert.equal(state.days["2026-06-06"].fields.reason_for_missing_level_a.value, "fatigue");
});

test("daily max questions and open question prevent notification spam", async () => {
  const { service, sent } = createService();

  await service.check({ accountId: "account-1" }, new Date("2026-06-06T20:05:00+02:00"));
  await service.check({ accountId: "account-1" }, new Date("2026-06-06T20:06:00+02:00"));

  assert.equal(sent.length, 1);
});

test("missing context skips when shift rating answer is still pending", async () => {
  const { service, sent, config } = createService();
  fs.writeFileSync(config.shiftRatingStateFile, `${JSON.stringify({
    lastPromptBySender: {
      "telegram:jane": {
        date: "2026-06-06",
        promptedAt: "2026-06-06T18:00:00+02:00",
        answeredAt: "",
      },
    },
  })}\n`);

  const result = await service.check({ accountId: "account-1" }, new Date("2026-06-06T20:05:00+02:00"));

  assert.equal(result.prompted.length, 0);
  assert.equal(sent.length, 0);
});

test("parseAnswer accepts numeric choices and skip", () => {
  const question = {
    options: [
      { key: "1", label: "太累", value: "fatigue" },
      { key: "2", label: "没时间", value: "time" },
    ],
  };

  assert.deepEqual(parseAnswer("2", question), {
    status: "answered",
    key: "2",
    label: "没时间",
    value: "time",
  });
  assert.deepEqual(parseAnswer("跳过", question), {
    status: "unknown",
    key: "unknown",
    label: "unknown",
    value: "unknown",
  });
});
