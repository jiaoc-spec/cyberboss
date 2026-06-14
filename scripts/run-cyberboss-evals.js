#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CurrentStateService,
  matchStateRule,
  parseSleepSpan,
} = require("../src/services/current-state-service");
const { extractTrackerEntries } = require("../src/services/obsidian-tracker-sync-service");
const { PeriodicReviewPipelineService } = require("../src/services/periodic-review-pipeline-service");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CASE_FILE = path.join(ROOT, "evals", "cyberboss", "cases.jsonl");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const caseFile = path.resolve(args.cases || DEFAULT_CASE_FILE);
  const cases = readJsonl(caseFile);
  const responses = args.responses ? readResponses(path.resolve(args.responses)) : new Map();

  const results = [];
  for (const testCase of cases) {
    try {
      const result = await runCase(testCase, { responses });
      results.push({ id: testCase.id, ...result });
    } catch (error) {
      results.push({
        id: testCase.id,
        status: "fail",
        message: error?.stack || error?.message || String(error),
      });
    }
  }

  printResults(results);
  if (results.some((result) => result.status === "fail")) {
    process.exitCode = 1;
  }
}

async function runCase(testCase, context) {
  switch (testCase.kind) {
    case "current_state":
      return runCurrentStateCase(testCase);
    case "tracker":
      return runTrackerCase(testCase);
    case "periodic":
      return runPeriodicCase(testCase);
    case "source_guard":
      return runSourceGuardCase(testCase);
    case "reply_quality":
      return runReplyQualityCase(testCase, context);
    default:
      throw new Error(`Unsupported case kind: ${testCase.kind}`);
  }
}

function runCurrentStateCase(testCase) {
  const expected = testCase.expect || {};
  const rule = matchStateRule(testCase.input || "");
  assertEqual(rule?.state || "", expected.state || "", "state");

  if (Object.prototype.hasOwnProperty.call(expected, "sleepApproxHours")) {
    const sleep = parseSleepSpan(testCase.input || "");
    assertApprox(sleep?.approxHours, expected.sleepApproxHours, 0.15, "sleepApproxHours");
  }

  if (testCase.busyAt) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-eval-current-state-"));
    const service = new CurrentStateService({
      config: {
        timeZone: "Europe/Berlin",
        currentStateFile: path.join(dir, "current-state.json"),
      },
    });
    service.observeMessage({
      text: testCase.input || "",
      receivedAt: testCase.receivedAt || new Date().toISOString(),
      provider: "eval",
      senderId: testCase.id || "case",
    });
    const busy = service.isBusyNow({ now: new Date(testCase.busyAt) });
    assertEqual(Boolean(busy.busy), Boolean(expected.busy), "busy");
  }

  return { status: "pass" };
}

function runTrackerCase(testCase) {
  const entries = extractTrackerEntries(testCase.note || "");
  const expectedEntries = testCase.expect?.entries || {};
  for (const [name, expectedValue] of Object.entries(expectedEntries)) {
    if (expectedValue === "__absent") {
      assertEqual(Object.prototype.hasOwnProperty.call(entries, name), false, `${name} absent`);
    } else {
      assertEqual(entries[name], expectedValue, name);
    }
  }
  return { status: "pass" };
}

async function runPeriodicCase(testCase) {
  const { service, queued } = makePeriodicFixture();
  const result = await service.check({ accountId: "eval-account" }, new Date(testCase.now));
  const expected = testCase.expect || {};

  if (Object.prototype.hasOwnProperty.call(expected, "actions")) {
    assertEqual(result.actions.length, expected.actions, "actions.length");
  }
  if (Object.prototype.hasOwnProperty.call(expected, "queued")) {
    assertEqual(queued.length, expected.queued, "queued.length");
  }
  if (expected.action) {
    assertEqual(result.actions[0]?.action || "", expected.action, "action");
  }
  if (expected.runKey) {
    assertEqual(result.actions[0]?.runKey || "", expected.runKey, "runKey");
  }
  if (expected.queuedPromptIncludes) {
    assertIncludes(queued[0]?.text || "", expected.queuedPromptIncludes, "queued prompt");
  }
  return { status: "pass" };
}

function runSourceGuardCase(testCase) {
  const target = path.resolve(ROOT, testCase.file || "");
  if (!target.startsWith(ROOT)) {
    throw new Error(`Refusing to read outside repo: ${testCase.file}`);
  }
  const source = fs.readFileSync(target, "utf8");
  const expected = testCase.expect || {};
  for (const pattern of expected.mustContain || []) {
    assertRegex(source, pattern, `mustContain ${pattern}`);
  }
  for (const pattern of expected.mustNotContain || []) {
    assertNotRegex(source, pattern, `mustNotContain ${pattern}`);
  }
  return { status: "pass" };
}

function runReplyQualityCase(testCase, { responses }) {
  if (!responses.has(testCase.id)) {
    return { status: "skip", message: "no response fixture supplied" };
  }
  const response = responses.get(testCase.id);
  const expected = testCase.expect || {};
  for (const pattern of expected.requiredPatterns || []) {
    assertRegex(response, pattern, `required ${pattern}`);
  }
  for (const pattern of expected.forbiddenPatterns || []) {
    assertNotRegex(response, pattern, `forbidden ${pattern}`);
  }
  return { status: "pass" };
}

function makePeriodicFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-eval-periodic-"));
  const queued = [];
  const config = {
    timeZone: "Europe/Berlin",
    workspaceRoot: "/workspace",
    periodicReviewPipelineStateFile: path.join(dir, "periodic-review.json"),
    weeklyReviewPipelineWeekday: 1,
    weeklyReviewPipelineHour: 4,
    monthlyReviewPipelineHour: 9,
    periodicReviewPipelineMaxAttempts: 3,
    periodicReviewPipelineRetryDelayMs: 60_000,
    obsidianVaultDir: path.join(dir, "vault"),
    obsidianWeeklyFolder: "周记",
    obsidianMonthlyFolder: "月记",
    obsidianDailyFolder: "日记",
  };
  const service = new PeriodicReviewPipelineService({
    config,
    channelAdapter: { getKnownContextTokens: () => ({ "eval-chat": "eval-token" }) },
    sessionStore: {
      buildBindingKey: () => "eval-binding",
      getActiveWorkspaceRoot: () => "/workspace",
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
      hasPendingForAccount: () => false,
    },
  });
  return { service, queued };
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: invalid JSONL: ${error.message}`);
      }
    });
}

function readResponses(filePath) {
  const responses = new Map();
  for (const row of readJsonl(filePath)) {
    if (row.id && typeof row.response === "string") {
      responses.set(row.id, row.response);
    }
  }
  return responses;
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--cases") {
      result.cases = args[index + 1];
      index += 1;
    } else if (arg === "--responses") {
      result.responses = args[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run eval:cyberboss -- [--cases evals/cyberboss/cases.jsonl] [--responses responses.jsonl]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertApprox(actual, expected, tolerance, label) {
  if (!Number.isFinite(Number(actual)) || Math.abs(Number(actual) - Number(expected)) > tolerance) {
    throw new Error(`${label}: expected approximately ${expected}, got ${actual}`);
  }
}

function assertIncludes(actual, expected, label) {
  if (!String(actual).includes(String(expected))) {
    throw new Error(`${label}: expected to include ${JSON.stringify(expected)}, got ${JSON.stringify(actual).slice(0, 240)}`);
  }
}

function assertRegex(actual, pattern, label) {
  const regex = new RegExp(pattern, "i");
  if (!regex.test(String(actual || ""))) {
    throw new Error(`${label}: pattern did not match`);
  }
}

function assertNotRegex(actual, pattern, label) {
  const regex = new RegExp(pattern, "i");
  if (regex.test(String(actual || ""))) {
    throw new Error(`${label}: forbidden pattern matched`);
  }
}

function printResults(results) {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const result of results) {
    if (result.status === "pass") {
      pass += 1;
      console.log(`PASS ${result.id}`);
    } else if (result.status === "skip") {
      skip += 1;
      console.log(`SKIP ${result.id} - ${result.message || ""}`);
    } else {
      fail += 1;
      console.error(`FAIL ${result.id}`);
      console.error(indent(result.message || "unknown error"));
    }
  }
  console.log(`\nCyberBoss evals: ${pass} passed, ${skip} skipped, ${fail} failed`);
}

function indent(text) {
  return String(text).split("\n").map((line) => `  ${line}`).join("\n");
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
