const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function setup() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tradesense-prune-"));
  process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");
  for (const name of ["store", "feedback"]) delete require.cache[require.resolve(`../src/autopilot/${name}`)];
  const store = require("../src/autopilot/store");
  const feedback = require("../src/autopilot/feedback");
  return {
    store,
    feedback,
    cleanup() {
      store.close();
      delete process.env.AUTOPILOT_DB_PATH;
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

const NOW = Date.parse("2026-10-03T12:00:00Z");
const daysAgo = (days) => new Date(NOW - days * 86400000).toISOString();

function seed(db) {
  for (const [id, days] of [["s-old", 30], ["s-edge", 15], ["s-new", 1]]) {
    db.prepare(
      "INSERT INTO shadow_candidates(id,scan_id,symbol,strategy,decision_at,reason_code,selected,features_json,policy_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(id, `scan-${id}`, "ABC", "orb15", daysAgo(days), "setup_valid", 0, "{}", "baseline-v3", daysAgo(days));
    db.prepare(
      "INSERT INTO selection_decisions(id,scan_id,setup_id,symbol,strategy,lane,selected,policy_version,features_json,decision_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(id, `scan-${id}`, `setup-${id}`, "ABC", "orb15", "day", 1, "baseline-v3", "{}", daysAgo(days), daysAgo(days));
  }
  for (let index = 1; index <= 5; index += 1) {
    db.prepare(
      "INSERT INTO feedback_datasets(id,dataset_version,as_of,label_horizon,policy_version,counts_json,coverage_json,checksum,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(`d${index}`, `v${index}`, daysAgo(10 - index), "d5", "baseline-v3", "{}", "{}", `c${index}`, daysAgo(10 - index));
    db.prepare(
      "INSERT INTO feedback_dataset_rows(id,dataset_id,setup_id,symbol,strategy,decision_at,feature_snapshot_json,label_json,coverage_status,sample_weight,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(`r${index}`, `d${index}`, "setup", "ABC", "orb15", daysAgo(10), "{}", "{}", "pending", 1, daysAgo(10 - index));
  }
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("pruneHistory drops aged shadow/selection rows and superseded dataset copies", () => {
  const { store, feedback, cleanup } = setup();
  try {
    const db = store.database();
    seed(db);
    const result = feedback.pruneHistory({ now: NOW, env: {} });
    assert.deepEqual(result, { datasetRows: 2, shadowCandidates: 2, selectionDecisions: 2 });
    assert.deepEqual(db.prepare("SELECT id FROM shadow_candidates").all().map((row) => row.id), ["s-new"]);
    assert.deepEqual(db.prepare("SELECT id FROM selection_decisions").all().map((row) => row.id), ["s-new"]);
    assert.deepEqual(
      db.prepare("SELECT dataset_id FROM feedback_dataset_rows ORDER BY dataset_id").all().map((row) => row.dataset_id),
      ["d3", "d4", "d5"],
    );
    assert.equal(count(db, "feedback_datasets"), 5, "dataset headers are kept for audit");
  } finally {
    cleanup();
  }
});

test("pruneHistory honours the retention and dataset-count settings and is idempotent", () => {
  const { store, feedback, cleanup } = setup();
  try {
    const db = store.database();
    seed(db);
    const env = { AUTOPILOT_SHADOW_RETENTION_DAYS: "40", AUTOPILOT_KEEP_DATASETS: "1" };
    assert.deepEqual(feedback.pruneHistory({ now: NOW, env }), { datasetRows: 4, shadowCandidates: 0, selectionDecisions: 0 });
    assert.equal(count(db, "shadow_candidates"), 3);
    assert.deepEqual(feedback.pruneHistory({ now: NOW, env }), { datasetRows: 0, shadowCandidates: 0, selectionDecisions: 0 });
  } finally {
    cleanup();
  }
});

test("a failed transaction surfaces its own error instead of the rollback error", () => {
  const { store, cleanup } = setup();
  try {
    const db = store.database();
    assert.throws(
      () =>
        store.transaction(() => {
          db.exec("ROLLBACK");
          throw new Error("original failure");
        }),
      /original failure/,
    );
  } finally {
    cleanup();
  }
});
