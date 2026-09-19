const crypto = require("node:crypto");
const store = require("./store");
const market = require("./market");
const alpaca = require("../providers/alpacaService");
const evaluator = require("./recommendationEvaluator");

const REVIEW_HORIZONS = ["plan"];

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function run(stmt, ...args) {
  return store.database().prepare(stmt).run(...args);
}

function all(stmt, ...args) {
  return store.database().prepare(stmt).all(...args);
}

function get(stmt, ...args) {
  return store.database().prepare(stmt).get(...args);
}

function planFromSignal(signal) {
  return {
    entry: signal.entry,
    maxEntry: signal.maxEntry,
    stop: signal.stop,
    target: signal.target,
    expiresAt: signal.expiresAt,
    deadline: signal.deadline,
    direction: "long",
    mode: signal.mode,
    reason: signal.reason || null,
    strategy: signal.strategy,
    version: signal.version,
    createdAt: signal.createdAt,
  };
}

function compactFeatures(signal) {
  const atrPct = signal.daily?.atr14 && signal.daily?.price
    ? (signal.daily.atr14 / signal.daily.price) * 100
    : null;
  return {
    gapPct: signal.gapPct ?? null,
    rvol: signal.rvol ?? null,
    atrPct,
    adv20: signal.daily?.avgDollarVolume20d ?? null,
    dataCutoff: signal.createdAt,
    rank: signal.rank ?? null,
  };
}

function fastMomentumTags(signal) {
  const momentum = ["orb15", "gap_pullback"].includes(signal.strategy);
  const atrPct = signal.daily?.atr14 && signal.daily?.price
    ? (signal.daily.atr14 / signal.daily.price) * 100
    : null;
  const fast = momentum && signal.rvol >= 2 && atrPct >= 3;
  return {
    fast_momentum_candidate: fast,
    fast_momentum_reason: fast ? "momentum_strategy_rvol2_atr3" : null,
  };
}

function rowToRecommendation(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticker: row.ticker,
    userId: row.user_id,
    sessionDate: row.session_date,
    strategy: row.strategy,
    strategyVersion: row.strategy_version,
    decisionAt: row.decision_at,
    triggerBarEndAt: row.trigger_bar_end_at,
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    deadline: row.deadline_at,
    status: row.status,
    plan: json(row.plan_json, {}),
    features: json(row.features_json, {}),
    provenance: json(row.provenance_json, {}),
    tags: json(row.tags_json, {}),
    snapshotHash: row.snapshot_hash,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function receiptId(recommendationId, userId, availableAt) {
  return hash({ recommendationId, userId, availableAt }).slice(0, 32);
}

function archiveSignal({ userId, signal, now = Date.now() }) {
  const publishedAt = signal.publishedAt || signal.createdAt || new Date(now).toISOString();
  const recommendationId = signal.recommendationId || signal.id;
  const plan = planFromSignal(signal);
  const features = compactFeatures(signal);
  const tags = fastMomentumTags(signal);
  const provenance = signal.provenance || {};
  const snapshotHash = hash({ plan, features, provenance, tags });
  const nowIso = new Date(now).toISOString();
  const rec = {
    id: recommendationId,
    ticker: signal.ticker,
    userId,
    sessionDate: market.nyDate(Date.parse(publishedAt)),
    strategy: signal.strategy,
    strategyVersion: signal.version || signal.strategyVersion || "unknown",
    decisionAt: signal.createdAt || publishedAt,
    triggerBarEndAt: signal.barAt || null,
    publishedAt,
    expiresAt: signal.expiresAt || null,
    deadline: signal.deadline || null,
    status: signal.status || "published",
    plan,
    features,
    provenance,
    tags,
    schemaVersion: 1,
    snapshotHash,
    source: "v3_live",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const rid = receiptId(recommendationId, userId, publishedAt);
  run(
    `INSERT INTO recommendations(id,ticker,user_id,session_date,strategy,strategy_version,decision_at,trigger_bar_end_at,published_at,expires_at,deadline_at,status,plan_json,features_json,provenance_json,tags_json,schema_version,snapshot_hash,source,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`,
    rec.id, rec.ticker, rec.userId, rec.sessionDate, rec.strategy, rec.strategyVersion, rec.decisionAt, rec.triggerBarEndAt,
    rec.publishedAt, rec.expiresAt, rec.deadline, rec.status, JSON.stringify(rec.plan), JSON.stringify(rec.features),
    JSON.stringify(rec.provenance), JSON.stringify(rec.tags), rec.schemaVersion, rec.snapshotHash, rec.source, rec.createdAt, rec.updatedAt,
  );
  run(
    `INSERT INTO recommendation_receipts(id,recommendation_id,user_id,available_at,sizing_json,channel,created_at)
     VALUES(?,?,?,?,?,?,?) ON CONFLICT(recommendation_id,user_id,available_at) DO NOTHING`,
    rid, recommendationId, userId, publishedAt, JSON.stringify(signal.sizing || {}), "dashboard", nowIso,
  );
  run(
    `INSERT INTO recommendation_events(id,recommendation_id,user_id,type,reason,payload_json,idempotency_key,created_at)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`,
    hash({ recommendationId, userId, type: "published" }).slice(0, 32),
    recommendationId, userId, "published", null, JSON.stringify({ signalId: signal.id }), `published:${recommendationId}:${userId}`, nowIso,
  );
  for (const horizon of REVIEW_HORIZONS) {
    const dueAt = new Date(Math.max(Date.parse(signal.deadline || publishedAt) + 900000, Date.parse(publishedAt) + 900000)).toISOString();
    const key = `${recommendationId}:${rid}:${evaluator.VERSION}:${horizon}`;
    run(
      `INSERT INTO recommendation_review_jobs(job_key,recommendation_id,receipt_id,user_id,horizon,due_at,state,cursor_json,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(job_key) DO NOTHING`,
      key, recommendationId, rid, userId, horizon, dueAt, "pending", "{}", nowIso,
    );
  }
  run(
    `INSERT INTO recommendation_outbox(id,recommendation_id,user_id,type,payload_json,created_at)
     VALUES(?,?,?,?,?,?) ON CONFLICT(recommendation_id,user_id,type) DO NOTHING`,
    hash({ recommendationId, userId, type: "signal" }).slice(0, 32), recommendationId, userId, "signal", JSON.stringify({ signalId: signal.id }), nowIso,
  );
  return { ...rec, receiptId: rid };
}

function updateLifecycle({ recommendationId, userId, type, reason, payload = {}, now = Date.now() }) {
  if (!get("SELECT id FROM recommendations WHERE id=?", recommendationId)) return false;
  const createdAt = new Date(now).toISOString();
  run(
    `INSERT INTO recommendation_events(id,recommendation_id,user_id,type,reason,payload_json,idempotency_key,created_at)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`,
    hash({ recommendationId, userId, type, reason }).slice(0, 32),
    recommendationId, userId, type, reason || null, JSON.stringify(payload), `${type}:${recommendationId}:${userId}:${reason || ""}`, createdAt,
  );
  run("UPDATE recommendations SET status=?, updated_at=? WHERE id=?", type, createdAt, recommendationId);
  return true;
}

function listForUser(userId, { limit = 50, cursor } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const args = [userId];
  let where = "WHERE user_id=?";
  if (cursor) {
    const [publishedAt, id] = Buffer.from(String(cursor), "base64url").toString("utf8").split("|");
    if (publishedAt && id) {
      where += " AND (published_at < ? OR (published_at = ? AND id < ?))";
      args.push(publishedAt, publishedAt, id);
    }
  }
  const rows = all(
    `SELECT * FROM recommendations ${where} ORDER BY published_at DESC,id DESC LIMIT ?`,
    ...args,
    safeLimit + 1,
  );
  const page = rows.slice(0, safeLimit).map(rowToRecommendation);
  const last = rows.length > safeLimit ? page.at(-1) : null;
  return {
    rows: page,
    nextCursor: last ? Buffer.from(`${last.publishedAt}|${last.id}`).toString("base64url") : null,
  };
}

function getForUser(userId, id) {
  const rec = rowToRecommendation(get("SELECT * FROM recommendations WHERE id=? AND user_id=?", id, userId));
  if (!rec) return null;
  rec.evaluations = all(
    "SELECT * FROM recommendation_evaluations WHERE recommendation_id=? ORDER BY checked_at DESC",
    id,
  ).map((row) => ({
    horizon: row.horizon,
    workflowStatus: row.workflow_status,
    outcomeStatus: row.outcome_status,
    metrics: json(row.metrics_json, {}),
    coverage: json(row.coverage_json, {}),
    ambiguity: json(row.ambiguity_json, {}),
    checkedAt: row.checked_at,
  }));
  return rec;
}

function summaryForUser(userId) {
  const rows = all(
    `SELECT r.strategy, r.strategy_version, r.tags_json, e.outcome_status, e.workflow_status, e.metrics_json, e.coverage_json
     FROM recommendations r
     LEFT JOIN recommendation_evaluations e ON e.recommendation_id=r.id AND e.horizon='plan'
     WHERE r.user_id=?`,
    userId,
  );
  const summary = {
    published: rows.length,
    complete: 0,
    pending: 0,
    noObservedFill: 0,
    unresolved: 0,
    ambiguous: 0,
    target: 0,
    stop: 0,
    timeExit: 0,
    fastMomentumPublished: 0,
    byStrategy: {},
    asOf: new Date().toISOString(),
    evaluatorVersion: evaluator.VERSION,
  };
  for (const row of rows) {
    const key = `${row.strategy}@${row.strategy_version}`;
    if (!summary.byStrategy[key]) summary.byStrategy[key] = { published: 0, complete: 0, target: 0, stop: 0, noObservedFill: 0 };
    summary.byStrategy[key].published += 1;
    if (json(row.tags_json, {})?.fast_momentum_candidate) summary.fastMomentumPublished += 1;
    if (!row.workflow_status) {
      summary.pending += 1;
      continue;
    }
    if (row.workflow_status === "complete") summary.complete += 1;
    if (row.outcome_status === "no_observed_fill") summary.noObservedFill += 1;
    if (row.outcome_status === "unresolved") summary.unresolved += 1;
    if (row.outcome_status === "ambiguous") summary.ambiguous += 1;
    if (row.outcome_status === "target") summary.target += 1;
    if (row.outcome_status === "stop") summary.stop += 1;
    if (row.outcome_status === "time_exit") summary.timeExit += 1;
    if (summary.byStrategy[key][row.outcome_status] != null) summary.byStrategy[key][row.outcome_status] += 1;
    if (row.workflow_status === "complete") summary.byStrategy[key].complete += 1;
  }
  return summary;
}

function dueJobs(now = Date.now(), limit = 25, owner = `worker:${process.pid}`) {
  const nowIso = new Date(now).toISOString();
  const jobs = all(
    `SELECT * FROM recommendation_review_jobs
     WHERE state IN ('pending','retryable_error') AND due_at<=? AND (next_retry_at IS NULL OR next_retry_at<=?) AND (lease_until IS NULL OR lease_until<=?)
     ORDER BY due_at ASC LIMIT ?`,
    nowIso, nowIso, nowIso, limit,
  );
  const claimed = [];
  for (const job of jobs) {
    const leaseUntil = new Date(now + 120000).toISOString();
    const result = run(
      `UPDATE recommendation_review_jobs SET state='evaluating', lease_owner=?, lease_until=?, updated_at=?
       WHERE job_key=? AND (lease_until IS NULL OR lease_until<=? OR lease_owner=?)`,
      owner, leaseUntil, nowIso, job.job_key, nowIso, owner,
    );
    if (result.changes) claimed.push({ ...job, lease_owner: owner, lease_until: leaseUntil });
  }
  return claimed;
}

async function evaluateJob(job, now = Date.now()) {
  const rec = rowToRecommendation(get("SELECT * FROM recommendations WHERE id=?", job.recommendation_id));
  if (!rec) throw new Error("recommendation_not_found");
  const start = rec.publishedAt;
  const end = rec.deadline || rec.expiresAt;
  if (!start || !end) throw new Error("missing_window");
  const bars = await alpaca.getIntradayBars({
    symbols: [rec.ticker],
    timeframe: "5Min",
    start,
    end: new Date(Date.parse(end) + 300000).toISOString(),
    feed: rec.provenance?.intradayFeed === "sip" ? "sip" : "iex",
    priority: "review",
  });
  const result = evaluator.evaluateRecommendation({ recommendation: rec, bars: bars.get(rec.ticker) || [], horizon: job.horizon });
  const checkedAt = new Date(now).toISOString();
  run(
    `INSERT INTO recommendation_evaluations(id,recommendation_id,receipt_id,user_id,evaluator_version,data_revision,horizon,workflow_status,outcome_status,metrics_json,coverage_json,ambiguity_json,checked_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(recommendation_id,receipt_id,evaluator_version,data_revision,horizon)
     DO UPDATE SET workflow_status=excluded.workflow_status,outcome_status=excluded.outcome_status,metrics_json=excluded.metrics_json,coverage_json=excluded.coverage_json,ambiguity_json=excluded.ambiguity_json,checked_at=excluded.checked_at`,
    hash({ job: job.job_key, version: result.evaluatorVersion }).slice(0, 32), rec.id, job.receipt_id, job.user_id, result.evaluatorVersion,
    result.coverage.dataRevision, job.horizon, result.workflowStatus, result.outcomeStatus, JSON.stringify(result.metrics),
    JSON.stringify(result.coverage), JSON.stringify(result.ambiguity), checkedAt,
  );
  const nextState = result.workflowStatus === "retryable_error" ? "retryable_error" : "complete";
  run(
    "UPDATE recommendation_review_jobs SET state=?, attempts=attempts+1, next_retry_at=?, lease_owner=NULL, lease_until=NULL, last_error=NULL, updated_at=? WHERE job_key=?",
    nextState,
    nextState === "retryable_error" ? new Date(now + 30 * 60000).toISOString() : null,
    checkedAt,
    job.job_key,
  );
  return result;
}

async function runDue({ now = Date.now(), limit = 25, owner } = {}) {
  const runId = hash({ now, owner: owner || process.pid }).slice(0, 32);
  const startedAt = new Date(now).toISOString();
  const counts = { claimed: 0, complete: 0, retryable: 0, failed: 0 };
  const failures = [];
  const jobs = dueJobs(now, limit, owner);
  counts.claimed = jobs.length;
  run(
    "INSERT INTO recommendation_review_runs(id,started_at,evaluator_version,cutoff_at,counts_json,cursor_json,provider_json,failures_json) VALUES(?,?,?,?,?,?,?,?)",
    runId, startedAt, evaluator.VERSION, startedAt, JSON.stringify(counts), "{}", JSON.stringify({ provider: "alpaca" }), "[]",
  );
  for (const job of jobs) {
    try {
      const result = await evaluateJob(job, now);
      if (result.workflowStatus === "complete") counts.complete += 1;
      else counts.retryable += 1;
    } catch (error) {
      counts.failed += 1;
      failures.push({ jobKey: job.job_key, error: error.message });
      const attempts = Number(job.attempts || 0) + 1;
      const delay = Math.min(24 * 3600000, 10 * 60000 * 2 ** Math.min(6, attempts));
      run(
        "UPDATE recommendation_review_jobs SET state='retryable_error', attempts=?, next_retry_at=?, lease_owner=NULL, lease_until=NULL, last_error=?, updated_at=? WHERE job_key=?",
        attempts, new Date(now + delay).toISOString(), error.message, new Date(now).toISOString(), job.job_key,
      );
    }
  }
  run(
    "UPDATE recommendation_review_runs SET completed_at=?, counts_json=?, failures_json=? WHERE id=?",
    new Date().toISOString(), JSON.stringify(counts), JSON.stringify(failures), runId,
  );
  return { runId, counts, failures };
}

module.exports = {
  REVIEW_HORIZONS,
  archiveSignal,
  updateLifecycle,
  listForUser,
  getForUser,
  summaryForUser,
  dueJobs,
  evaluateJob,
  runDue,
  fastMomentumTags,
};
