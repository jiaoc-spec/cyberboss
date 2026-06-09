const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { resolveTargetKeywords, matchPatternsByDomain } = require("../src/core/pattern-domain-map");
const { UnmatchedEvidenceStore } = require("../src/core/unmatched-evidence-store");

// --- resolveTargetKeywords ---

test("health maps to night-shift and recovery keywords", () => {
  const kw = resolveTargetKeywords("health");
  assert.ok(kw.includes("night-shift"));
  assert.ok(kw.includes("recovery"));
});

test("sport maps to health and night-shift keywords", () => {
  const kw = resolveTargetKeywords("sport");
  assert.ok(kw.includes("health"));
  assert.ok(kw.includes("night-shift"));
});

test("learning maps to learning and night-shift keywords", () => {
  const kw = resolveTargetKeywords("learning");
  assert.ok(kw.includes("learning"));
  assert.ok(kw.includes("night-shift"));
});

test("decision-patterns maps to work and career keywords", () => {
  const kw = resolveTargetKeywords("decision-patterns");
  assert.ok(kw.includes("work"));
  assert.ok(kw.includes("career"));
});

test("shift-rating maps to night-shift and energy", () => {
  const kw = resolveTargetKeywords("shift-rating");
  assert.ok(kw.includes("night-shift"));
  assert.ok(kw.includes("energy"));
});

test("unknown domain returns null", () => {
  assert.equal(resolveTargetKeywords("unknown-xyz"), null);
  assert.equal(resolveTargetKeywords(""), null);
  assert.equal(resolveTargetKeywords(null), null);
});

// --- matchPatternsByDomain ---

const SAMPLE_PATTERNS = [
  { id: "p1", domain: "night-shift", title: "Night shift weakens habits" },
  { id: "p2", domain: "screen-time", title: "Screen time accounting" },
  { id: "p3", domain: "work", title: "Work patterns" },
  { id: "p4", domain: "recovery", title: "Recovery after night shift" },
  { id: "p5", domain: "learning", title: "Learning patterns" },
];

test("health matches night-shift and recovery patterns", () => {
  const matches = matchPatternsByDomain(SAMPLE_PATTERNS, "health");
  const ids = matches.map((p) => p.id);
  assert.ok(ids.includes("p1"), "should match night-shift");
  assert.ok(ids.includes("p4"), "should match recovery");
  assert.equal(ids.includes("p2"), false, "should not match screen-time");
});

test("learning matches learning and night-shift patterns", () => {
  const matches = matchPatternsByDomain(SAMPLE_PATTERNS, "learning");
  const ids = matches.map((p) => p.id);
  assert.ok(ids.includes("p5"), "should match learning");
  assert.ok(ids.includes("p1"), "should match night-shift");
});

test("decision-patterns matches work pattern", () => {
  const matches = matchPatternsByDomain(SAMPLE_PATTERNS, "decision-patterns");
  const ids = matches.map((p) => p.id);
  assert.ok(ids.includes("p3"), "should match work");
});

test("unknown domain matches nothing", () => {
  const matches = matchPatternsByDomain(SAMPLE_PATTERNS, "completely-unknown");
  assert.equal(matches.length, 0);
});

test("screen-time domain matches nothing for sport source", () => {
  const matches = matchPatternsByDomain(SAMPLE_PATTERNS, "sport");
  const ids = matches.map((p) => p.id);
  assert.equal(ids.includes("p2"), false, "screen-time should not match sport");
});

// --- UnmatchedEvidenceStore ---

function makeTmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-ue-"));
  return new UnmatchedEvidenceStore({ filePath: path.join(dir, "unmatched-evidence.json") });
}

test("append and list unmatched evidence", () => {
  const store = makeTmpStore();
  store.append({ originDomain: "health", note: "Sport win, no pattern match", source: "wins-ledger", date: "2026-06-07" });
  const data = store.list();
  assert.equal(data.unmatchedEvidence.length, 1);
  assert.equal(data.unmatchedEvidence[0].originDomain, "health");
  assert.ok(data.unmatchedEvidence[0].id.startsWith("ue_"));
});

test("multiple appends accumulate", () => {
  const store = makeTmpStore();
  store.append({ originDomain: "health", note: "A", source: "wins-ledger", date: "2026-06-07" });
  store.append({ originDomain: "learning", note: "B", source: "wins-ledger", date: "2026-06-07" });
  const data = store.list();
  assert.equal(data.unmatchedEvidence.length, 2);
});

test("starts empty on fresh file", () => {
  const store = makeTmpStore();
  const data = store.list();
  assert.equal(data.unmatchedEvidence.length, 0);
  assert.equal(data.schemaVersion, 1);
});
