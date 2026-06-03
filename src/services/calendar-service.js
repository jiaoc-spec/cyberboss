const { spawn } = require("child_process");
const path = require("path");

class CalendarService {
  constructor({ config }) {
    this.config = config || {};
  }

  async read(args = {}) {
    const provider = normalizeText(args.provider) || normalizeText(this.config.calendarProvider) || "apple";
    if (provider !== "apple") {
      throw new Error(`Unsupported calendar provider: ${provider}`);
    }
    return await readAppleCalendar({
      scriptFile: this.config.appleCalendarScriptFile,
      start: normalizeText(args.start),
      end: normalizeText(args.end),
      days: normalizePositiveInteger(args.days),
      calendars: normalizeTextArray(args.calendars),
      includeNotes: args.includeNotes === true,
      includeUrls: args.includeUrls === true,
      requestAccess: args.requestAccess === true,
    });
  }
}

async function readAppleCalendar(options = {}) {
  const scriptFile = normalizeText(options.scriptFile) || path.resolve(__dirname, "..", "..", "scripts", "apple-calendar-read.swift");
  const argv = [scriptFile];
  if (options.start) {
    argv.push("--start", options.start);
  }
  if (options.end) {
    argv.push("--end", options.end);
  }
  if (options.days) {
    argv.push("--days", String(options.days));
  }
  if (options.calendars.length) {
    argv.push("--calendars", options.calendars.join(","));
  }
  if (options.includeNotes) {
    argv.push("--include-notes", "true");
  }
  if (options.includeUrls) {
    argv.push("--include-urls", "true");
  }
  if (options.requestAccess) {
    argv.push("--request-access", "true");
  }

  const execution = await runCommand("swift", argv, { timeoutMs: 30_000 });
  const parsed = parseJsonOutput(execution.stdout);
  if (execution.code !== 0 && parsed?.authorization !== "denied") {
    throw new Error(summarizeCalendarFailure(execution, parsed));
  }
  return parsed;
}

function runCommand(command, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.resolve(__dirname, "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill("SIGTERM");
          reject(new Error(`calendar command timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseJsonOutput(output) {
  const text = normalizeText(output);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`calendar command returned invalid JSON: ${error.message}`);
  }
}

function summarizeCalendarFailure(execution, parsed) {
  const parts = [];
  if (parsed?.error) {
    parts.push(parsed.error);
  }
  if (execution.stderr) {
    parts.push(execution.stderr.trim());
  }
  return parts.filter(Boolean).join(" ") || `calendar command failed with exit code ${execution.code}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

module.exports = { CalendarService };
