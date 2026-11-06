const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.AUTOPILOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-reviewjobs-")), "test.sqlite");
const recommendations = require("../src/autopilot/recommendations");
const { DatabaseSync } = require("node:sqlite");

test("retry policy: exponential backoff, and abandon once a data problem will not fix itself", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  const delayMin = (plan) => Math.round((Date.parse(plan.nextRetryAt) - now) / 60000);
  assert.deepEqual([1, 2, 3, 4].map((n) => delayMin(recommendations.nextRetryPlan(n, "calendar_unavailable", now))), [30, 60, 120, 240]);
  assert.equal(recommendations.nextRetryPlan(7, "calendar_unavailable", now).state, "retryable_error");
  assert.deepEqual(recommendations.nextRetryPlan(8, "calendar_unavailable", now), { state: "abandoned", nextRetryAt: null });
  // A bar gap in the past never fills in later: three tries, then stop.
  assert.equal(recommendations.nextRetryPlan(2, "internal_bar_gap", now).state, "retryable_error");
  assert.equal(recommendations.nextRetryPlan(3, "internal_bar_gap", now).state, "abandoned");
});

test("the review queue serves never-tried jobs before retries and abandons exhausted ones (they used to take every slot)", () => {
  recommendations.dueJobs(Date.now(), 1); // opens the database and creates the schema
  const db = new DatabaseSync(process.env.AUTOPILOT_DB_PATH); 
  db.exec("PRAGMA foreign_keys=OFF"); // the jobs below deliberately have no parent rows
  const insert = db.prepare(
    "INSERT INTO recommendation_review_jobs(job_key,recommendation_id,receipt_id,user_id,horizon,due_at,state,attempts,next_retry_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  const old = "2026-10-01T20:00:00.000Z";
  const recent = "2026-10-08T20:00:00.000Z";
  insert.run("stuck-1", "r1", "x1", "u1", "d1", old, "retryable_error", 1500, old, old); // exhausted: must be abandoned
  insert.run("stuck-2", "r2", "x2", "u1", "d1", old, "evaluating", 1368, null, old); // exhausted, lease long expired
  insert.run("retry-1", "r3", "x3", "u1", "d1", old, "retryable_error", 2, old, old); // still has attempts left
  insert.run("fresh-1", "r4", "x4", "u1", "d0", recent, "pending", 0, null, recent);
  insert.run("fresh-2", "r5", "x5", "u1", "d0", recent, "pending", 0, null, recent);
  const claimed = recommendations.dueJobs(Date.now(), 2, "test-owner");
  assert.deepEqual(claimed.map((job) => job.job_key).sort(), ["fresh-1", "fresh-2"], "never-tried jobs come first even though a retry is older");
  const states = Object.fromEntries(db.prepare("SELECT job_key, state FROM recommendation_review_jobs").all().map((row) => [row.job_key, row.state]));
  assert.equal(states["stuck-1"], "abandoned");
  assert.equal(states["stuck-2"], "abandoned");
  assert.equal(states["retry-1"], "retryable_error");
});
