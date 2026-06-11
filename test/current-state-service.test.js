const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CurrentStateService,
  evaluateBusyState,
  matchStateRule,
  parseSleepSpan,
} = require("../src/services/current-state-service");

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-current-state-"));
  return new CurrentStateService({
    config: {
      timeZone: "Europe/Berlin",
      currentStateFile: path.join(dir, "current-state.json"),
    },
  });
}

test("the real morning message: commuting wins over woke_up, sleep span parsed", () => {
  // Jane's actual message that CyberBoss misread on 2026-06-11
  const text = "我现在去上早班，我是零点以后才睡着，四点半就起床";

  const rule = matchStateRule(text);
  assert.equal(rule.state, "commuting_to_work");

  const sleep = parseSleepSpan(text);
  assert.equal(sleep.sleptAtHour, 0);
  assert.equal(sleep.wokeAtHour, 4.5);
  assert.equal(sleep.approxHours, 4.5);
});

test("observeMessage records assertion and busy state gates while fresh", () => {
  const service = makeService();
  const result = service.observeMessage({
    text: "我现在去上早班",
    receivedAt: "2026-06-11T06:30:00+02:00",
    provider: "telegram",
    senderId: "jane",
  });
  assert.equal(result.stateUpdated, true);
  assert.equal(result.state, "commuting_to_work");

  const busySoon = service.isBusyNow({ now: new Date("2026-06-11T06:50:00+02:00") });
  assert.equal(busySoon.busy, true);

  const muchLater = service.isBusyNow({ now: new Date("2026-06-11T12:00:00+02:00") });
  assert.equal(muchLater.busy, false);
});

test("state transitions: off work clears busy", () => {
  const service = makeService();
  service.observeMessage({ text: "开始早班", receivedAt: "2026-06-11T07:00:00+02:00", provider: "telegram", senderId: "jane" });
  assert.equal(service.isBusyNow({ now: new Date("2026-06-11T10:00:00+02:00") }).busy, true);

  service.observeMessage({ text: "下班了，好累", receivedAt: "2026-06-11T15:00:00+02:00", provider: "telegram", senderId: "jane" });
  assert.equal(service.isBusyNow({ now: new Date("2026-06-11T15:10:00+02:00") }).busy, false);
  assert.equal(service.current({ now: new Date("2026-06-11T15:10:00+02:00") }).state, "off_work");
});

test("commands and ordinary chat do not create assertions", () => {
  const service = makeService();
  assert.equal(service.observeMessage({ text: "/status" }).stateUpdated, false);
  assert.equal(service.observeMessage({ text: "今天天气不错" }).stateUpdated, false);
});

test("various phrasings map to expected states", () => {
  assert.equal(matchStateRule("出门了").state, "commuting_to_work");
  assert.equal(matchStateRule("我去上夜班了").state, "commuting_to_work");
  assert.equal(matchStateRule("到医院了，准备交接").state, "at_work");
  assert.equal(matchStateRule("夜班结束了，坐车回家").state, "commuting_home");
  assert.equal(matchStateRule("到家了").state, "arrived_home");
  assert.equal(matchStateRule("我去睡了，晚安").state, "going_to_sleep");
  assert.equal(matchStateRule("刚睡醒").state, "woke_up");
});

test("sleep span handles evening-to-morning crossing", () => {
  const sleep = parseSleepSpan("晚上十一点才睡，六点就起床了");
  assert.equal(sleep.sleptAtHour, 23);
  assert.equal(sleep.wokeAtHour, 6);
  assert.equal(sleep.approxHours, 7);
});

test("evaluateBusyState works on raw state for the checkin poller", () => {
  const state = {
    assertions: [{
      state: "at_work",
      label: "正在上班",
      assertedAt: "2026-06-11T07:00:00.000Z",
      sourceText: "开始早班",
    }],
    sleep: {},
  };
  assert.equal(evaluateBusyState(state, new Date("2026-06-11T09:00:00.000Z")).busy, true);
  assert.equal(evaluateBusyState(state, new Date("2026-06-11T20:00:00.000Z")).busy, false);
});

test("lastSleep returns today's record", () => {
  const service = makeService();
  service.observeMessage({
    text: "我是零点以后才睡着，四点半就起床",
    receivedAt: "2026-06-11T06:30:00+02:00",
    provider: "telegram",
    senderId: "jane",
  });
  const sleep = service.lastSleep({ now: new Date("2026-06-11T08:00:00+02:00") });
  assert.equal(sleep.approxHours, 4.5);
});
