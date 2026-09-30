const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
let db;
let dbFile;

function ensureWritableDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.tradesense-write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function defaultDatabaseCandidates() {
  const local = path.resolve(__dirname, "../data/autopilot.sqlite");
  const temp = path.join(os.tmpdir(), "tradesense", "autopilot.sqlite");
  if (process.env.RENDER) return ["/var/data/autopilot.sqlite", temp];
  return [local, "/var/data/autopilot.sqlite", temp];
}

function resolveDatabaseFile() {
  if (process.env.AUTOPILOT_DB_PATH) return path.resolve(process.env.AUTOPILOT_DB_PATH);
  for (const candidate of defaultDatabaseCandidates()) {
    if (ensureWritableDirectory(path.dirname(candidate))) return candidate;
  }
  return path.join(os.tmpdir(), "tradesense", "autopilot.sqlite");
}

function fallbackDatabaseFile(primaryFile) {
  const temp = path.join(os.tmpdir(), "tradesense", "autopilot.sqlite");
  return path.resolve(primaryFile) === path.resolve(temp) ? null : temp;
}

function configureJournal(database, file) {
  try {
    database.exec("PRAGMA busy_timeout=5000;");
  } catch (error) {
    console.warn(`[autopilot-store] busy_timeout unavailable for ${file}; continuing. ${error.message}`);
  }
  try {
    database.exec("PRAGMA journal_mode=WAL;");
  } catch (error) {
    console.warn(`[autopilot-store] WAL unavailable for ${file}; falling back to DELETE journal. ${error.message}`);
    try {
      database.exec("PRAGMA journal_mode=DELETE;");
    } catch (fallbackError) {
      console.warn(`[autopilot-store] DELETE journal unavailable for ${file}; continuing with SQLite default. ${fallbackError.message}`);
    }
  }
}

function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  configureJournal(database, file);
  database.exec(
    "CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, metadata TEXT, PRIMARY KEY(kind,id));",
  );
  return database;
}

function database() {
  if (!db) {
    const file = resolveDatabaseFile();
    try {
      db = openDatabase(file);
      dbFile = file;
      if (!process.env.AUTOPILOT_DB_PATH && process.env.RENDER && !file.startsWith("/var/data/")) {
        console.warn(`[autopilot-store] AUTOPILOT_DB_PATH is not set and /var/data is not writable. Using ephemeral SQLite at ${file}; data will not survive deploys.`);
      } else {
        console.log(`[autopilot-store] SQLite path: ${file}`);
      }
    } catch (error) {
      const fallback = fallbackDatabaseFile(file);
      console.warn(`[autopilot-store] Failed to initialize SQLite at ${file}: ${error.message}`);
      if (!fallback) {
        error.message = `Failed to initialize autopilot SQLite at ${file}: ${error.message}. On Render, attach a persistent disk mounted at /var/data and set AUTOPILOT_DB_PATH=/var/data/autopilot.sqlite.`;
        throw error;
      }
      try {
        db = openDatabase(fallback);
        dbFile = fallback;
        console.warn(`[autopilot-store] Using ephemeral fallback SQLite at ${fallback}; data will not survive deploys. Fix /var/data or AUTOPILOT_DB_PATH for persistence.`);
      } catch (fallbackError) {
        fallbackError.message = `Failed to initialize autopilot SQLite at ${file} and fallback ${fallback}: ${fallbackError.message}. On Render, attach a persistent disk mounted at /var/data and set AUTOPILOT_DB_PATH=/var/data/autopilot.sqlite.`;
        throw fallbackError;
      }
    }
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
      CREATE TABLE IF NOT EXISTS market_evidence_metadata (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        feed TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        revision TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        reproducibility TEXT NOT NULL DEFAULT 'limited',
        fetched_at TEXT NOT NULL,
        UNIQUE(provider,feed,symbol,window_start,window_end,revision,evidence_type)
      );
      CREATE TABLE IF NOT EXISTS corporate_action_checks (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        status TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        UNIQUE(provider,symbol,window_start,window_end)
      );
      CREATE TABLE IF NOT EXISTS catalyst_events (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        event_at TEXT,
        first_seen_at TEXT,
        event_type TEXT NOT NULL,
        source TEXT,
        title TEXT,
        url TEXT,
        relation TEXT NOT NULL DEFAULT 'post_hoc_explanation',
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        UNIQUE(provider,symbol,event_type,event_at,title)
      );
      CREATE TABLE IF NOT EXISTS evaluation_revisions (
        id TEXT PRIMARY KEY,
        recommendation_id TEXT NOT NULL REFERENCES recommendations(id),
        receipt_id TEXT,
        user_id TEXT,
        evaluator_version TEXT NOT NULL,
        data_revision TEXT NOT NULL,
        previous_evaluation_id TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shadow_candidates (
        id TEXT PRIMARY KEY,
        scan_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        strategy TEXT NOT NULL,
        decision_at TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        selected INTEGER NOT NULL DEFAULT 0,
        features_json TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(scan_id,symbol,strategy)
      );
      CREATE TABLE IF NOT EXISTS selection_decisions (
        id TEXT PRIMARY KEY,
        scan_id TEXT NOT NULL,
        setup_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        strategy TEXT NOT NULL,
        lane TEXT,
        selected INTEGER NOT NULL DEFAULT 0,
        baseline_rank INTEGER,
        policy_rank INTEGER,
        policy_version TEXT NOT NULL,
        reason_code TEXT,
        features_json TEXT NOT NULL,
        decision_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(scan_id,setup_id,policy_version)
      );
      CREATE TABLE IF NOT EXISTS feedback_datasets (
        id TEXT PRIMARY KEY,
        dataset_version TEXT NOT NULL UNIQUE,
        as_of TEXT NOT NULL,
        label_horizon TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        counts_json TEXT NOT NULL,
        coverage_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feedback_dataset_rows (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES feedback_datasets(id),
        setup_id TEXT NOT NULL,
        recommendation_id TEXT,
        shadow_candidate_id TEXT,
        symbol TEXT NOT NULL,
        strategy TEXT NOT NULL,
        decision_at TEXT NOT NULL,
        feature_snapshot_json TEXT NOT NULL,
        label_json TEXT NOT NULL,
        coverage_status TEXT NOT NULL,
        sample_weight REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(dataset_id,setup_id)
      );
      CREATE TABLE IF NOT EXISTS policy_candidates (
        policy_version TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        feature_schema_version TEXT NOT NULL,
        hyperparams_json TEXT NOT NULL,
        training_dataset_version TEXT,
        train_cutoff_at TEXT,
        gate_version TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        previous_policy_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policy_evaluations (
        id TEXT PRIMARY KEY,
        policy_version TEXT NOT NULL,
        dataset_version TEXT,
        stage TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        gates_json TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policy_activations (
        id TEXT PRIMARY KEY,
        policy_version TEXT NOT NULL,
        state TEXT NOT NULL,
        reason TEXT NOT NULL,
        previous_policy_version TEXT,
        activated_at TEXT,
        rollback_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_checkpoints (
        name TEXT PRIMARY KEY,
        cursor_json TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recommendations_user_published ON recommendations(user_id,published_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS idx_recommendations_strategy_session ON recommendations(strategy,strategy_version,session_date);
      CREATE INDEX IF NOT EXISTS idx_recommendation_receipts_user_available ON recommendation_receipts(user_id,available_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS idx_recommendation_jobs_state_due ON recommendation_review_jobs(state,due_at,next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_recommendation_evaluations_scope ON recommendation_evaluations(recommendation_id,receipt_id,evaluator_version,horizon);
      CREATE INDEX IF NOT EXISTS idx_market_evidence_symbol_window ON market_evidence_metadata(symbol,window_start,window_end,feed);
      CREATE INDEX IF NOT EXISTS idx_catalyst_events_symbol_time ON catalyst_events(symbol,event_at,provider);
      CREATE INDEX IF NOT EXISTS idx_shadow_candidates_scan ON shadow_candidates(scan_id,strategy,selected);
      CREATE INDEX IF NOT EXISTS idx_selection_decisions_scan ON selection_decisions(scan_id,strategy,selected);
      CREATE INDEX IF NOT EXISTS idx_feedback_dataset_rows_dataset ON feedback_dataset_rows(dataset_id,strategy,coverage_status);
      CREATE INDEX IF NOT EXISTS idx_policy_candidates_state ON policy_candidates(state,updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_candidates_single_active_limited ON policy_candidates(state) WHERE state='active_limited';
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
    dbFile = null;
  }
}
module.exports = {
  database,
  resolveDatabaseFile,
  ensureWritableDirectory,
  get dbFile() { return dbFile; },
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
