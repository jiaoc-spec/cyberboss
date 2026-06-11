const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CampaignService } = require("../src/services/campaign-service");
const { ResearchLedgerService } = require("../src/services/research-ledger-service");

function makeCampaign() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-campaign-"));
  return new CampaignService({
    config: {
      timeZone: "Europe/Berlin",
      campaignsFile: path.join(dir, "campaigns.json"),
      campaignBoostDaysBefore: 14,
    },
  });
}

test("campaign upsert and status with upcoming deadlines", async () => {
  const service = makeCampaign();
  const campaign = await service.upsert({
    name: "WS 2026/27 Semester 1",
    startDate: "2026-10-01",
    endDate: "2027-02-28",
    deadlines: [
      { label: "Statistik Klausur", date: "2026-12-15", habitId: "python" },
      { label: "Hausarbeit Abgabe", date: "2027-01-30" },
    ],
  });
  assert.ok(campaign.id.startsWith("cmp_"));

  const status = await service.status({ date: "2026-12-05" });
  assert.equal(status.activeCampaigns.length, 1);
  assert.equal(status.upcomingDeadlines[0].label, "Statistik Klausur");
  assert.equal(status.upcomingDeadlines[0].daysLeft, 10);
  assert.equal(status.upcomingDeadlines[0].boosting, true);
});

test("boostedHabitIds only within window and campaign period", () => {
  const service = makeCampaign();
  return service.upsert({
    name: "Exam",
    startDate: "2026-10-01",
    endDate: "2027-02-28",
    deadlines: [{ label: "Klausur", date: "2026-12-15", habitId: "python" }],
  }).then(() => {
    assert.deepEqual(service.boostedHabitIds("2026-12-05"), ["python"]);
    assert.deepEqual(service.boostedHabitIds("2026-11-01"), []);
    assert.deepEqual(service.boostedHabitIds("2026-12-16"), []);
    assert.deepEqual(service.boostedHabitIds("2027-03-05"), []);
  });
});

test("research ledger records and queries with type counts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-research-"));
  const service = new ResearchLedgerService({
    config: { timeZone: "Europe/Berlin", researchLedgerFile: path.join(dir, "research.json") },
  });
  await service.record({ type: "paper", title: "Exsudatmanagement RCT", note: "反直觉的结论", tags: ["Wunde"], date: "2026-06-10" });
  await service.record({ type: "idea", title: "夜班与习惯回弹的纵向研究", date: "2026-06-11" });

  const papers = await service.query({ type: "paper" });
  assert.equal(papers.total, 1);
  assert.equal(papers.countsByType.paper, 1);
  assert.equal(papers.countsByType.idea, 1);

  const search = await service.query({ query: "夜班" });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].type, "idea");

  await assert.rejects(() => service.record({ type: "nonsense", title: "x" }), /type must be one of/);
});
