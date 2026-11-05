const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.AUTOPILOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-qindex-")), "test.sqlite");
const store = require("../src/autopilot/store");
const recommendations = require("../src/autopilot/recommendations");

test("the dashboard quality report looks jobs up by index instead of scanning the whole jobs table", () => {
  store.get("runtime", "engine"); // opens the database and creates the schema
  const db = store.database ? store.database() : new (require("node:sqlite").DatabaseSync)(process.env.AUTOPILOT_DB_PATH);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='recommendation_review_jobs'").all().map((row) => row.name);
  assert.ok(indexes.includes("idx_recommendation_jobs_recommendation"), indexes.join(","));
  const report = recommendations.qualityReportForUser("qindex-user-1");
  assert.deepEqual(report.rows, []);
});

test("a failed schema setup (database locked) is retried on the next call instead of leaving a half-initialised store", () => {
  const { spawnSync } = require("node:child_process");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-locked-")), "locked.sqlite");
  const script = `
    process.env.AUTOPILOT_DB_PATH = ${JSON.stringify(file)};
    const { DatabaseSync } = require("node:sqlite");
    const blocker = new DatabaseSync(process.env.AUTOPILOT_DB_PATH);
    blocker.exec("PRAGMA journal_mode=WAL; CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, metadata TEXT, PRIMARY KEY(kind,id));");
    const store = require(${JSON.stringify(path.resolve(__dirname, "../src/autopilot/store"))});
    blocker.exec("BEGIN IMMEDIATE");            // another process (the previous container) is writing
    let locked = false;
    try { store.get("runtime", "x"); } catch (error) { locked = /locked/.test(error.message); }
    blocker.exec("COMMIT");
    store.get("runtime", "x");                  // must run the schema setup again, not reuse a half-built db
    const check = new DatabaseSync(process.env.AUTOPILOT_DB_PATH, { readOnly: true });
    const names = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
    console.log(JSON.stringify({ locked, hasIndex: names.includes("idx_recommendation_jobs_recommendation") }));
  `;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60000 });
  const line = result.stdout.trim().split("\n").pop();
  assert.deepEqual(JSON.parse(line), { locked: true, hasIndex: true }, result.stderr);
});
