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
