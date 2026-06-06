const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { DecisionJournalService } = require("../src/services/decision-journal-service");

function makeTmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-dj-"));
  return {
    decisionJournalFile: path.join(dir, "decision-journal.json"),
  };
}

test("records a decision with required fields", async () => {
  const service = new DecisionJournalService({ config: makeTmpConfig() });
  const decision = await service.record({
    decision: "I will start nursing science bachelor in October",
    context: "Enrollment deadline approaching",
  });
  assert.ok(decision.id);
  assert.equal(decision.decision, "I will start nursing science bachelor in October");
  assert.ok(decision.date);
  assert.ok(decision.createdAt);
  assert.equal(decision.later_outcome, "");
  assert.equal(decision.reflection, "");
});

test("persists decisions to file", async () => {
  const config = makeTmpConfig();
  const service = new DecisionJournalService({ config });
  await service.record({ decision: "Stop doing X", context: "tired" });
  await service.record({ decision: "Start doing Y", context: "motivated" });
  const data = JSON.parse(fs.readFileSync(config.decisionJournalFile, "utf8"));
  assert.equal(data.decisions.length, 2);
  assert.equal(data.schemaVersion, 1);
});

test("updates outcome of an existing decision", async () => {
  const config = makeTmpConfig();
  const service = new DecisionJournalService({ config });
  const d = await service.record({ decision: "Try running daily", context: "energy" });
  const updated = await service.updateOutcome({
    id: d.id,
    later_outcome: "Did it for 3 weeks then stopped",
    reflection: "Too ambitious, 5 min version would have been better",
  });
  assert.equal(updated.later_outcome, "Did it for 3 weeks then stopped");
  assert.ok(updated.updatedAt);
});

test("updateOutcome throws for unknown id", async () => {
  const service = new DecisionJournalService({ config: makeTmpConfig() });
  await assert.rejects(
    () => service.updateOutcome({ id: "nonexistent", later_outcome: "X" }),
    /not found/
  );
});

test("list returns all decisions most recent first", async () => {
  const config = makeTmpConfig();
  const service = new DecisionJournalService({ config });
  await service.record({ decision: "First", context: "" });
  await service.record({ decision: "Second", context: "" });
  const result = await service.list({});
  assert.equal(result.decisions.length, 2);
  assert.equal(result.decisions[0].decision, "Second");
});

test("list filters by pending_review_only", async () => {
  const config = makeTmpConfig();
  const service = new DecisionJournalService({ config });
  const d1 = await service.record({ decision: "One", context: "", review_date: "2026-07-01" });
  await service.updateOutcome({ id: d1.id, later_outcome: "Done", reflection: "" });
  await service.record({ decision: "Two", context: "", review_date: "2026-08-01" });
  const result = await service.list({ pending_review_only: true });
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].decision, "Two");
});
