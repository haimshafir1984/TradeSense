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
