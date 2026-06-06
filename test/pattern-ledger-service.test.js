const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { PatternLedgerService } = require("../src/services/pattern-ledger-service");

function makeTmpConfig(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-pl-"));
  const file = path.join(dir, "pattern-ledger.json");
  if (initial) {
    fs.writeFileSync(file, JSON.stringify(initial, null, 2), "utf8");
  }
  return { patternLedgerFile: file };
}

test("adds a new pattern with enhanced schema", async () => {
  const service = new PatternLedgerService({ config: makeTmpConfig() });
  const pattern = await service.add({
    title: "Night shift reduces Level A completion",
    domain: "night-shift",
    observation: "Sport and Deutsch are skipped more often on night-shift recovery days.",
    hypothesis: "Sleep debt reduces the available energy window for habit tasks.",
    confidence: "medium",
    impact: "health,learning",
    tags: ["Level A", "night shift"],
  });
  assert.ok(pattern.id);
  assert.equal(pattern.title, "Night shift reduces Level A completion");
  assert.equal(pattern.confidence, "medium");
  assert.ok(Array.isArray(pattern.intervention_ideas));
  assert.ok(Array.isArray(pattern.outcome_tracking));
  assert.ok(Array.isArray(pattern.evidence));
});

test("reads existing patterns without destroying them", async () => {
  const existing = {
    schemaVersion: 1,
    updatedAt: "2026-06-06T00:00:00.000Z",
    patterns: [
      {
        id: "pat_abc123",
        title: "Old pattern",
        domain: "work",
        status: "active",
        confidence: 0.7,
        summary: "Some old pattern",
      },
    ],
  };
  const config = makeTmpConfig(existing);
  const service = new PatternLedgerService({ config });
  const result = await service.list({});
  assert.equal(result.patterns.length, 1);
  assert.equal(result.patterns[0].id, "pat_abc123");
});

test("adds evidence to existing pattern", async () => {
  const config = makeTmpConfig();
  const service = new PatternLedgerService({ config });
  const p = await service.add({ title: "Test pattern", domain: "test" });
  await service.addEvidence({
    id: p.id,
    date: "2026-06-06",
    source: "daily-review",
    note: "Pattern confirmed again",
    weight: 1,
  });
  const result = await service.list({});
  assert.equal(result.patterns[0].evidence.length, 1);
  assert.equal(result.patterns[0].evidence[0].note, "Pattern confirmed again");
});

test("adds intervention idea to existing pattern", async () => {
  const config = makeTmpConfig();
  const service = new PatternLedgerService({ config });
  const p = await service.add({ title: "Recovery pattern", domain: "health" });
  await service.addIntervention({
    id: p.id,
    idea: "On night-shift recovery days, only require 5-minute Sport version.",
    target_domain: "health",
  });
  const updated = (await service.list({})).patterns[0];
  assert.equal(updated.intervention_ideas.length, 1);
  assert.equal(updated.intervention_ideas[0].idea, "On night-shift recovery days, only require 5-minute Sport version.");
});

test("list filters by domain", async () => {
  const config = makeTmpConfig();
  const service = new PatternLedgerService({ config });
  await service.add({ title: "Health pattern", domain: "health" });
  await service.add({ title: "Learning pattern", domain: "learning" });
  const result = await service.list({ domain: "learning" });
  assert.equal(result.patterns.length, 1);
});

test("confidence can be string or float and both are accepted", async () => {
  const config = makeTmpConfig();
  const service = new PatternLedgerService({ config });
  const p1 = await service.add({ title: "P1", domain: "x", confidence: "high" });
  const p2 = await service.add({ title: "P2", domain: "x", confidence: "low" });
  assert.equal(p1.confidence, "high");
  assert.equal(p2.confidence, "low");
});
