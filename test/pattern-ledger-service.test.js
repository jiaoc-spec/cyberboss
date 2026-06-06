const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PatternLedgerService } = require("../src/services/pattern-ledger-service");

function createService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-pattern-ledger-"));
  return new PatternLedgerService({
    config: {
      patternLedgerFile: path.join(dir, "pattern-ledger.json"),
    },
  });
}

test("pattern ledger upserts by domain and title and merges evidence", () => {
  const service = createService();

  const first = service.upsert({
    title: "Night shift recovery affects Level A habits",
    domain: "night-shift",
    confidence: 0.4,
    summary: "Night shifts appear to make Sport, Deutsch, and Englisch harder.",
    evidence: [{ date: "2026-06-05", source: "daily-review", note: "Night shift recovery day had missing Level A habits." }],
  });
  const second = service.upsert({
    title: "Night shift recovery affects Level A habits",
    domain: "night-shift",
    confidence: 0.55,
    supportStrategy: "Use minimum versions after wake-up instead of full tasks.",
    evidence: [{ date: "2026-06-12", source: "weekly-review", note: "Similar pattern repeated after another night shift." }],
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.pattern.evidence.length, 2);
  assert.equal(second.pattern.confidence, 0.55);
  assert.match(second.pattern.supportStrategy, /minimum/);

  const read = service.read({ domain: "night-shift" });
  assert.equal(read.count, 1);
  assert.equal(read.patterns[0].evidence.at(-1).date, "2026-06-12");
});

test("pattern ledger addEvidence updates an existing pattern", () => {
  const service = createService();
  const created = service.upsert({
    title: "Screen time expands in low-energy windows",
    domain: "screen-time",
    evidence: [{ date: "2026-06-05", source: "timeline", note: "Screen time appeared during night shift and recovery." }],
  });

  const updated = service.addEvidence({
    patternId: created.pattern.id,
    confidence: 0.5,
    evidence: [{ date: "2026-06-06", source: "daily-review", note: "Another low-energy screen-time block appeared." }],
  });

  assert.equal(updated.pattern.evidence.length, 2);
  assert.equal(updated.pattern.confidence, 0.5);
  assert.equal(updated.pattern.lastSeenAt, "2026-06-06");
});
