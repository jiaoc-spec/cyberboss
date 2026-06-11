const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DecisionJournalService } = require("../src/services/decision-journal-service");
const { DecisionReviewMonitor } = require("../src/services/decision-review-monitor");

function makeJournal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-decision-review-"));
  const config = {
    timeZone: "Europe/Berlin",
    decisionJournalFile: path.join(dir, "decision-journal.json"),
    decisionReviewDefaultDays: 14,
    decisionReviewEnabled: true,
    decisionReviewCheckIntervalMs: 1,
    decisionReviewHour: 11,
    userName: "Jane",
    workspaceRoot: "/workspace",
  };
  return { config, journal: new DecisionJournalService({ config }) };
}

test("record fills review_date with a +14 day default", async () => {
  const { journal } = makeJournal();
  const entry = await journal.record({ decision: "我决定先不换工作", date: "2026-06-01" });
  assert.equal(entry.review_date, "2026-06-15");
});

test("record keeps an explicit review_date", async () => {
  const { journal } = makeJournal();
  const entry = await journal.record({ decision: "我决定试一个月早睡", date: "2026-06-01", review_date: "2026-07-01" });
  assert.equal(entry.review_date, "2026-07-01");
});

test("listDueForReview returns only due, unanswered, unasked decisions", async () => {
  const { journal } = makeJournal();
  const due = await journal.record({ decision: "决定 A", date: "2026-05-01" });
  await journal.record({ decision: "决定 B", date: "2026-06-09" });
  const answered = await journal.record({ decision: "决定 C", date: "2026-05-01" });
  await journal.updateOutcome({ id: answered.id, later_outcome: "结果不错" });

  const list = await journal.listDueForReview({ date: "2026-06-10" });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, due.id);

  await journal.markReviewRequested({ id: due.id });
  const after = await journal.listDueForReview({ date: "2026-06-10" });
  assert.equal(after.length, 0);
});

test("monitor queues one follow-up and marks it requested", async () => {
  const { config, journal } = makeJournal();
  const decision = await journal.record({ decision: "我决定先继续用 fallback", date: "2026-05-20" });
  const queued = [];
  const monitor = new DecisionReviewMonitor({
    config,
    channelAdapter: {
      getKnownContextTokens() {
        return { "chat-1": "token-1" };
      },
    },
    sessionStore: {
      buildBindingKey() {
        return "binding";
      },
      getActiveWorkspaceRoot() {
        return "/workspace";
      },
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
    decisionJournal: journal,
  });

  const result = await monitor.check({ accountId: "account-1" }, new Date("2026-06-10T12:00:00+02:00"));
  assert.equal(result.queued.length, 1);
  assert.match(queued[0].text, /Decision Journal follow-up: DELIVERY REQUIRED/);
  assert.match(queued[0].text, /我决定先继续用 fallback/);
  assert.match(queued[0].text, new RegExp(decision.id));

  monitor.lastCheckAtMs = 0;
  const second = await monitor.check({ accountId: "account-1" }, new Date("2026-06-10T13:00:00+02:00"));
  assert.equal(second.queued.length, 0);
});

test("monitor stays quiet before the review hour", async () => {
  const { config, journal } = makeJournal();
  await journal.record({ decision: "决定 X", date: "2026-05-20" });
  const queued = [];
  const monitor = new DecisionReviewMonitor({
    config,
    channelAdapter: { getKnownContextTokens: () => ({}) },
    sessionStore: {},
    systemMessageQueue: { enqueue: (m) => queued.push(m) },
    decisionJournal: journal,
  });

  const result = await monitor.check({ accountId: "account-1" }, new Date("2026-06-10T08:00:00+02:00"));
  assert.equal(result.queued.length, 0);
  assert.equal(queued.length, 0);
});
