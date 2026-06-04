const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
const { CyberbossApp } = require("../src/core/app");

test("session store persists the last local activity date per runtime workspace", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-rollover-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath, runtimeId: "codex" });

  store.setThreadActivityDateForWorkspace("binding-1", "/workspace", "2026-06-04");

  const reloaded = new SessionStore({ filePath, runtimeId: "codex" });
  assert.equal(
    reloaded.getThreadActivityDateForWorkspace("binding-1", "/workspace"),
    "2026-06-04"
  );
});

test("daily thread rollover clears the old thread on the first normal message of a new local day", async () => {
  const calls = [];
  let activityDate = "2026-06-03";
  let threadId = "thread-old";
  const sessionStore = {
    getThreadActivityDateForWorkspace() {
      return activityDate;
    },
    setThreadActivityDateForWorkspace(bindingKey, workspaceRoot, date) {
      calls.push(["date", bindingKey, workspaceRoot, date]);
      activityDate = date;
    },
    getThreadIdForWorkspace() {
      return threadId;
    },
    clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
      calls.push(["clear", bindingKey, workspaceRoot]);
      threadId = "";
    },
  };
  const appLike = {
    config: {
      dailyThreadRollover: true,
      diaryTimeZone: "Europe/Berlin",
    },
    runtimeAdapter: {
      getSessionStore() {
        return sessionStore;
      },
      async startFreshThreadDraft(payload) {
        calls.push(["fresh", payload.bindingKey, payload.workspaceRoot]);
      },
    },
  };

  const rolledOver = await CyberbossApp.prototype.rollOverDailyThreadIfNeeded.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    normalized: {
      provider: "telegram",
      receivedAt: "2026-06-03T22:05:00.000Z",
    },
  });

  assert.equal(rolledOver, true);
  assert.deepEqual(calls, [
    ["fresh", "binding-1", "/workspace"],
    ["clear", "binding-1", "/workspace"],
    ["date", "binding-1", "/workspace", "2026-06-04"],
  ]);
});
