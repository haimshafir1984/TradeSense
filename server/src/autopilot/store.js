const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
let db;
function database() {
  if (!db) {
    const file =
      process.env.AUTOPILOT_DB_PATH ||
      path.resolve(__dirname, "../data/autopilot.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, metadata TEXT, PRIMARY KEY(kind,id));",
    );
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS recommendation_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recommendations (
        id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_date TEXT,
        strategy TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        decision_at TEXT,
        trigger_bar_end_at TEXT,
        published_at TEXT NOT NULL,
        expires_at TEXT,
        deadline_at TEXT,
        status TEXT NOT NULL DEFAULT 'published',
        plan_json TEXT NOT NULL,
        features_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        snapshot_hash TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'v3_live',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recommendation_receipts (
        id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL REFERENCES recommendations(id),
        user_id TEXT NOT NULL,
        available_at TEXT NOT NULL,
        sizing_json TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'dashboard',
        created_at TEXT NOT NULL,
        UNIQUE(recommendation_id,user_id,available_at)
      );
      CREATE TABLE IF NOT EXISTS recommendation_events (
        id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL REFERENCES recommendations(id),
        user_id TEXT,
        type TEXT NOT NULL,
        reason TEXT,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recommendation_evaluations (
        id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL REFERENCES recommendations(id),
        receipt_id TEXT,
        user_id TEXT,
        evaluator_version TEXT NOT NULL,
        data_revision TEXT NOT NULL,
        horizon TEXT NOT NULL,
        workflow_status TEXT NOT NULL,
        outcome_status TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        coverage_json TEXT NOT NULL,
        ambiguity_json TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        UNIQUE(recommendation_id,receipt_id,evaluator_version,data_revision,horizon)
      );
      CREATE TABLE IF NOT EXISTS recommendation_review_jobs (
        job_key TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL REFERENCES recommendations(id),
        receipt_id TEXT,
        user_id TEXT,
        horizon TEXT NOT NULL,
        due_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        cursor_json TEXT NOT NULL DEFAULT '{}',
        lease_owner TEXT,
        lease_until TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recommendation_outbox (
        id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL REFERENCES recommendations(id),
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(recommendation_id,user_id,type)
      );
      CREATE TABLE IF NOT EXISTS recommendation_review_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        evaluator_version TEXT NOT NULL,
        cutoff_at TEXT NOT NULL,
        counts_json TEXT NOT NULL,
        cursor_json TEXT NOT NULL,
        provider_json TEXT NOT NULL,
        failures_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recommendations_user_published ON recommendations(user_id,published_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS idx_recommendations_strategy_session ON recommendations(strategy,strategy_version,session_date);
      CREATE INDEX IF NOT EXISTS idx_recommendation_receipts_user_available ON recommendation_receipts(user_id,available_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS idx_recommendation_jobs_state_due ON recommendation_review_jobs(state,due_at,next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_recommendation_evaluations_scope ON recommendation_evaluations(recommendation_id,receipt_id,evaluator_version,horizon);
    `);
    db.prepare("INSERT OR IGNORE INTO recommendation_migrations(version,applied_at) VALUES(?,?)").run(1, new Date().toISOString());
    const columns = db.prepare("PRAGMA table_info(records)").all().map((row) => row.name);
    if (!columns.includes("metadata")) db.exec("ALTER TABLE records ADD COLUMN metadata TEXT");
    db.exec("UPDATE records SET metadata=json_object('symbol',json_extract(body,'$.symbol'),'feed',json_extract(body,'$.feed'),'timeframe',json_extract(body,'$.timeframe'),'lastUsedAt',json_extract(body,'$.lastUsedAt'),'fetchedAt',json_extract(body,'$.fetchedAt'),'sessionDate',json_extract(body,'$.sessionDate'),'barCount',json_array_length(json_extract(body,'$.bars')),'protected',json_extract(body,'$.protected')) WHERE kind='history' AND metadata IS NULL");
  }
  return db;
}
function get(kind, id) {
  const row = database()
    .prepare("SELECT body FROM records WHERE kind=? AND id=?")
    .get(kind, id);
  return row ? JSON.parse(row.body) : null;
}
function list(kind) {
  return database()
    .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid DESC")
    .all(kind)
    .map((r) => JSON.parse(r.body));
}
function listIds(kind) {
  return database()
    .prepare("SELECT id FROM records WHERE kind=? ORDER BY rowid DESC")
    .all(kind)
    .map((r) => r.id);
}
function listMetadata(kind) {
  return database()
    .prepare("SELECT id, metadata FROM records WHERE kind=? ORDER BY rowid DESC")
    .all(kind)
    .map((row) => ({ id: row.id, ...(row.metadata ? JSON.parse(row.metadata) : {}) }));
}
function put(kind, id, body) {
  database()
    .prepare(
      "INSERT INTO records(kind,id,body,metadata) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body, metadata=excluded.metadata",
    )
    .run(kind, id, JSON.stringify(body), kind === "history" ? JSON.stringify({ symbol: body.symbol || null, feed: body.feed || null, timeframe: body.timeframe || null, lastUsedAt: body.lastUsedAt || null, fetchedAt: body.fetchedAt || null, sessionDate: body.sessionDate || null, barCount: Array.isArray(body.bars) ? body.bars.length : 0, protected: body.protected === true }) : null);
  return body;
}
function remove(kind, id) {
  database().prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
}
function userKind(userId, kind) {
  if (!userId || typeof userId !== "string" || userId.length > 80)
    throw new Error("משתמש לא תקין");
  return `user:${userId}:${kind}`;
}
function getUser(userId, kind, id) {
  return get(userKind(userId, kind), id);
}
function listUser(userId, kind) {
  return list(userKind(userId, kind));
}
function putUser(userId, kind, id, body) {
  return put(userKind(userId, kind), id, body);
}
function removeUser(userId, kind, id) {
  return remove(userKind(userId, kind), id);
}
function transaction(fn) {
  database().exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database().exec("COMMIT");
    return result;
  } catch (error) {
    database().exec("ROLLBACK");
    throw error;
  }
}
function lease(name, durationMs, now = Date.now()) {
  return transaction(() => {
    if ((get("lease", name)?.until || 0) > now) return false;
    put("lease", name, { until: now + durationMs });
    return true;
  });
}
function close() {
  if (db) {
    db.close();
    db = null;
  }
}
module.exports = {
  database,
  get,
  list,
  listIds,
  listMetadata,
  put,
  remove,
  getUser,
  listUser,
  putUser,
  removeUser,
  transaction,
  lease,
  close,
};
