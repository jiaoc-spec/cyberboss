#!/usr/bin/env node
"use strict";

const path = require("path");
const os = require("os");
const { checkReviewStatus, formatStatusReport } = require("../src/services/daily-review-check");

const date = process.argv[2];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("Usage: npm run review-status -- YYYY-MM-DD");
  console.error("Example: npm run review-status -- 2026-06-08");
  process.exit(1);
}

const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
const obsidianDailyNoteDir = process.env.CYBERBOSS_OBSIDIAN_DAILY_DIR || "";

const result = checkReviewStatus({ stateDir, obsidianDailyNoteDir, date });
console.log(formatStatusReport(result));
