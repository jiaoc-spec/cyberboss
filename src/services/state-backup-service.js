const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// Daily local snapshot of the state directory. Pattern ledger, wins,
// decisions, research ledger and diary are months of irreplaceable memory;
// one corrupted write should never be able to erase them. Requires the state
// dir to be a git repository (one-time `git init`); otherwise stays quiet.
class StateBackupService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.stateDir = this.config.stateDir;
    this.lastCheckAtMs = 0;
    this.warnedMissingRepo = false;
  }

  async check(now = new Date()) {
    if (this.config.stateBackupEnabled === false || !this.stateDir) {
      return { backed: false };
    }
    const intervalMs = 30 * 60_000;
    if (this.lastCheckAtMs && now.getTime() - this.lastCheckAtMs < intervalMs) {
      return { backed: false };
    }
    this.lastCheckAtMs = now.getTime();

    const timeZone = this.config.timeZone || this.config.diaryTimeZone || "UTC";
    const local = localParts(now, timeZone);
    const hour = Number.isInteger(this.config.stateBackupHour) ? this.config.stateBackupHour : 1;
    if (local.hour < hour) {
      return { backed: false };
    }
    if (!fs.existsSync(path.join(this.stateDir, ".git"))) {
      if (!this.warnedMissingRepo) {
        this.warnedMissingRepo = true;
        console.warn(`[cyberboss] state backup skipped: ${this.stateDir} is not a git repository (run git init there once)`);
      }
      return { backed: false };
    }

    const marker = this.loadMarker();
    if (marker.lastBackupDate === local.date) {
      return { backed: false };
    }

    try {
      await git(this.stateDir, ["add", "-A"]);
      const status = await git(this.stateDir, ["status", "--porcelain"]);
      if (!status.trim()) {
        this.saveMarker({ lastBackupDate: local.date, lastResult: "clean" });
        return { backed: false, reason: "no_changes" };
      }
      await git(this.stateDir, ["commit", "-m", `auto snapshot ${local.date}`, "--no-gpg-sign"]);
      this.saveMarker({ lastBackupDate: local.date, lastResult: "committed" });
      console.log(`[cyberboss] state backup committed date=${local.date}`);
      return { backed: true };
    } catch (error) {
      console.error(`[cyberboss] state backup failed: ${error.message}`);
      return { backed: false, error: error.message };
    }
  }

  markerFile() {
    return path.join(this.stateDir, "state-backup.json");
  }

  loadMarker() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.markerFile(), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  saveMarker(marker) {
    fs.writeFileSync(this.markerFile(), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  }
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0]} failed: ${String(stderr || stdout || error.message).trim()}`));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function localParts(date, timeZone) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

module.exports = { StateBackupService };
