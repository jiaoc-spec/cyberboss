// Golden scenarios: real CyberBoss failures, frozen as regression tests.
//
// When CyberBoss misbehaves in real life, add the exact user message here with
// the behavior that SHOULD have happened. Every instruction or service change
// must keep these green. Scenario 1 is the 2026-06-11 early-shift failure.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CurrentStateService, matchStateRule, parseSleepSpan } = require("../src/services/current-state-service");
const { PlaybookService, buildPlaybookTrigger } = require("../src/services/playbook-service");

const repoRoot = path.resolve(__dirname, "..");

function makeCurrentState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-golden-"));
  return new CurrentStateService({
    config: { timeZone: "Europe/Berlin", currentStateFile: path.join(dir, "cs.json") },
  });
}

test("scenario 1 (2026-06-11): 去上早班 must mean she is up and out, not in bed", () => {
  // Real message. CyberBoss replied 醒了就先别急着起 - wrong on every level.
  const message = "我现在去上早班，我是零点以后才睡着，四点半就起床";

  // commuting must win over the 起床 mention in the same sentence
  assert.equal(matchStateRule(message).state, "commuting_to_work");
  // the short night must be captured as data, not as "she is still in bed"
  assert.equal(parseSleepSpan(message).approxHours, 4.5);

  // and while commuting, the system must hold all questions and reminders
  const service = makeCurrentState();
  service.observeMessage({ text: message, receivedAt: "2026-06-11T06:30:00+02:00", provider: "telegram", senderId: "jane" });
  assert.equal(service.isBusyNow({ now: new Date("2026-06-11T07:00:00+02:00") }).busy, true);
});

test("scenario 1 guard: dispatcher preamble lists commuting as clear awake evidence", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/core/system-message-dispatcher.js"), "utf8");
  assert.match(source, /commuting, heading out, or going to work/);
  assert.match(source, /我现在去上早班/);
  assert.match(source, /Early shift \(Frühdienst \/ 早班\) is not night-shift recovery/);
});

test("scenario 1 guard: persona template keeps the now-state-first paragraph", () => {
  const template = fs.readFileSync(path.join(repoRoot, "templates/weixin-instructions.md"), "utf8");
  assert.match(template, /先搞清楚她"现在正在干什么"，再决定怎么回/);
  assert.match(template, /绝对不要说"先别急着起"/);
});

test("scenario 2: a digit reply to a playbook prompt must start instantly without any model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-golden-pb-"));
  const playbook = new PlaybookService({
    config: { timeZone: "Europe/Berlin", playbookFile: path.join(dir, "pb.json") },
  });
  const now = new Date("2026-06-11T18:00:00+02:00");
  const rule = playbook.matchAnchor({ anchor: "arrived_home", now });
  playbook.recordPrompt(rule, now);

  // within the window: 1 must resolve to a concrete startable action
  const pending = playbook.pendingQuickStart({ now: new Date("2026-06-11T18:10:00+02:00") });
  assert.ok(pending);
  assert.ok(pending.task);
  assert.ok(pending.minutes >= 3);

  // and the bridge interceptor must recognize the same replies the prompt offers
  const digitPattern = /^(1|好|好的|开始|开始吧|ok|go)$/i;
  for (const reply of ["1", "好", "开始", "ok"]) {
    assert.ok(digitPattern.test(reply), `bridge must accept "${reply}"`);
  }
  const appSource = fs.readFileSync(path.join(repoRoot, "src/core/app.js"), "utf8");
  assert.match(appSource, /handlePlaybookQuickStart/);
  assert.match(appSource, /\^\(1\|好\|好的\|开始\|开始吧\|ok\|go\)\$/);
});

test("scenario 3: playbook prompts must never present menus", () => {
  const text = buildPlaybookTrigger(
    { id: "pb", anchor: "arrived_home", task: "Sport", label: "运动 10 分钟", minutes: 10 },
    "到家了",
    "Jane",
  );
  assert.match(text, /no menus, no three choices/);
  assert.match(text, /never re-ask/);
  const ops = fs.readFileSync(path.join(repoRoot, "templates/weixin-operations.md"), "utf8");
  assert.match(ops, /one digit must always be enough to begin/);
});

test("scenario 4 (2026-06-12): just-woke-up must get a full hour before any task prompt", () => {
  // Real failure: Jane said she woke at ~9:00; at 09:02 the playbook pushed
  // Deutsch, and at 09:08 a check-in added 德语那 10 分钟别拖太久.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-golden-wake-"));
  const playbook = new PlaybookService({
    config: { timeZone: "Europe/Berlin", playbookFile: path.join(dir, "pb.json") },
  });
  const wake = playbook._load().rules.find((rule) => rule.anchor === "woke_up");
  assert.ok(wake.graceMinutes >= 60, "woke_up grace must be at least an hour");

  playbook.schedulePrompt(wake, { anchor: "woke_up", senderId: "jane", now: new Date("2026-06-12T09:01:00+02:00") });
  assert.equal(playbook.duePendingPrompts({ now: new Date("2026-06-12T09:08:00+02:00") }).length, 0,
    "8 minutes after waking there must be no prompt");

  // instructions must forbid re-mentioning an unanswered prompt
  const ops = fs.readFileSync(path.join(repoRoot, "templates/weixin-operations.md"), "utf8");
  assert.match(ops, /one-shot and then CLOSED/);
  assert.match(ops, /别拖太久/);
  assert.match(ops, /The first hour after \{\{USER_NAME\}\} wakes up belongs to her own routine/);
});

test("scenario 5 (2026-06-12): backstage narration must be stripped from replies", () => {
  // Real failure: "我先把这段状态接住，再判断要不要顺手给你留一个今晚的收尾提醒" was sent to Jane.
  const source = fs.readFileSync(path.join(repoRoot, "src/core/stream-delivery.js"), "utf8");
  const leakLine = "我先把这段状态接住，再判断要不要顺手给你留一个今晚的收尾提醒，避免你晚上又被拖散。";
  const pattern = /^我(?:先|会|来)?把.{0,12}(?:状态|情绪|这段|这条).{0,8}(?:接住|接稳|稳住|收住)/;
  assert.ok(pattern.test(leakLine), "leak pattern must match the real leaked line");
  assert.ok(source.includes("接住|接稳|稳住|收住"), "stream-delivery must carry the leak pattern");
  // and a normal supportive line must NOT be stripped
  assert.ok(!pattern.test("你这段其实挺关键：昨晚补回来了，今天就别再跟睡眠较劲。"));
});

test("scenario 6 (2026-06-13): a digit answer to the wins question must never reach the model", async () => {
  // Real failure: Jane answered 3 (=有提醒) to the Wins question; the bridge
  // recorded it but let "3" continue to DeepSeek, which misread it as a
  // 3/10 energy score. A second bug sent 记录失败：factor is not defined.
  const { CyberbossApp } = require("../src/core/app");
  const { WinsLedgerState } = require("../src/core/wins-ledger-state");

  const sent = [];
  const recorded = [];
  const evidence = [];
  const state = new WinsLedgerState();
  state.setPending("jane", { task: "Englisch", domain: "learning", date: "2026-06-13" });

  const appLike = {
    winsLedgerState: state,
    projectServices: {
      wins: {
        async record(args) {
          recorded.push(args);
          return { id: "win_1", ...args };
        },
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
    async autoAddPatternEvidence(args) {
      evidence.push(args);
    },
  };

  const handled = await CyberbossApp.prototype.handleWinsLedgerIntercept.call(appLike, {
    senderId: "jane",
    text: "3",
    contextToken: "ctx",
  });

  assert.equal(handled, true, "the digit answer must be consumed at the bridge");
  assert.equal(recorded[0].success_factor, "had_reminder");
  assert.ok(sent.some((text) => text.includes("已记录到 Wins Ledger")));
  assert.ok(!sent.some((text) => text.includes("记录失败")), "no ReferenceError leak to chat");
  assert.match(evidence[0].note, /had_reminder/);
});

test("scenario 6 guard: off-day must forbid after-shift framing in temporal context", () => {
  const appSource = fs.readFileSync(path.join(repoRoot, "src/core/app.js"), "utf8");
  assert.match(appSource, /today is an OFF day per her calendar/);
  assert.match(appSource, /下班回来 \/ 下早班/);
});
