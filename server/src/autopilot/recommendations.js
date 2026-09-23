const crypto = require("node:crypto");
const store = require("./store");
const market = require("./market");
const alpaca = require("../providers/alpacaService");
const finnhub = require("../providers/finnhubService");
const sec = require("../providers/secService");
const evaluator = require("./recommendationEvaluator");

const REVIEW_HORIZONS = ["plan", "d0", "d1", "d3", "d5"];

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
    sourceSignalId: signal.id,
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

function recommendationIdForSignal(userId, signal, publishedAt) {
  const sourceSignalId = signal.id || signal.recommendationId || `${signal.ticker}:${signal.strategy}`;
  return signal.recommendationId || `${sourceSignalId}:${hash({ userId, publishedAt }).slice(0, 10)}`;
}

function latestEvaluationSelect() {
  return `(
    SELECT json_object(
      'horizon', e.horizon,
      'workflowStatus', e.workflow_status,
      'outcomeStatus', e.outcome_status,
      'evaluatorVersion', e.evaluator_version,
      'dataRevision', e.data_revision,
      'metrics', json(e.metrics_json),
      'coverage', json(e.coverage_json),
      'ambiguity', json(e.ambiguity_json),
      'checkedAt', e.checked_at
    )
    FROM recommendation_evaluations e
    WHERE e.recommendation_id=r.id AND e.user_id=r.user_id AND e.horizon='plan'
    ORDER BY e.checked_at DESC,e.evaluator_version DESC,e.data_revision DESC,e.id DESC
    LIMIT 1
  ) AS evaluation_json`;
}

function dueAtForHorizon(signal, publishedAt, horizon) {
  const base = Date.parse(signal.deadline || signal.expiresAt || publishedAt);
  const published = Date.parse(publishedAt);
  const byHorizon = { plan: 15 * 60000, d0: 60 * 60000, d1: 1 * 86400000 + 60 * 60000, d3: 3 * 86400000 + 60 * 60000, d5: 5 * 86400000 + 60 * 60000 };
  return new Date(Math.max(base + 20 * 60000, published + (byHorizon[horizon] || 60 * 60000))).toISOString();
}

function archiveSignal({ userId, signal, now = Date.now() }) {
  const publishedAt = signal.publishedAt || new Date(now).toISOString();
  const recommendationId = recommendationIdForSignal(userId, signal, publishedAt);
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
    const dueAt = dueAtForHorizon(signal, publishedAt, horizon);
    const version = horizon === "plan" ? evaluator.VERSION : evaluator.SIP_QUOTES_VERSION;
    const key = `${recommendationId}:${rid}:${version}:${horizon}`;
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
  const rec = get("SELECT id FROM recommendations WHERE id=? AND user_id=?", recommendationId, userId)
    || get("SELECT id FROM recommendations WHERE user_id=? AND json_extract(plan_json,'$.sourceSignalId')=? ORDER BY published_at DESC LIMIT 1", userId, recommendationId);
  if (!rec) return false;
  const resolvedId = rec.id;
  const createdAt = new Date(now).toISOString();
  run(
    `INSERT INTO recommendation_events(id,recommendation_id,user_id,type,reason,payload_json,idempotency_key,created_at)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`,
    hash({ resolvedId, userId, type, reason }).slice(0, 32),
    resolvedId, userId, type, reason || null, JSON.stringify(payload), `${type}:${resolvedId}:${userId}:${reason || ""}`, createdAt,
  );
  run("UPDATE recommendations SET status=?, updated_at=? WHERE id=? AND user_id=?", type, createdAt, resolvedId, userId);
  return true;
}

function listForUser(userId, { limit = 50, cursor } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const args = [userId];
  let where = "WHERE r.user_id=?";
  if (cursor) {
    const [publishedAt, id] = Buffer.from(String(cursor), "base64url").toString("utf8").split("|");
    if (publishedAt && id) {
      where += " AND (r.published_at < ? OR (r.published_at = ? AND r.id < ?))";
      args.push(publishedAt, publishedAt, id);
    }
  }
  const rows = all(
    `SELECT r.*, ${latestEvaluationSelect()} FROM recommendations r ${where} ORDER BY published_at DESC,id DESC LIMIT ?`,
    ...args,
    safeLimit + 1,
  );
  const page = rows.slice(0, safeLimit).map((row) => ({
    ...rowToRecommendation(row),
    evaluation: json(row.evaluation_json, null),
  }));
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
    "SELECT * FROM recommendation_evaluations WHERE recommendation_id=? AND user_id=? ORDER BY checked_at DESC,evaluator_version DESC,data_revision DESC,id DESC",
    id, userId,
  ).map((row) => ({
    horizon: row.horizon,
    workflowStatus: row.workflow_status,
    outcomeStatus: row.outcome_status,
    metrics: json(row.metrics_json, {}),
    coverage: json(row.coverage_json, {}),
    ambiguity: json(row.ambiguity_json, {}),
    checkedAt: row.checked_at,
  }));
  rec.catalysts = all(
    "SELECT provider,event_at AS eventAt,event_type AS eventType,source,title,url,relation,fetched_at AS fetchedAt FROM catalyst_events WHERE symbol=? AND event_at BETWEEN ? AND ? ORDER BY event_at ASC LIMIT 50",
    rec.ticker,
    new Date(Date.parse(rec.publishedAt) - 86400000).toISOString(),
    new Date(Date.parse(rec.deadline || rec.expiresAt || rec.publishedAt) + 6 * 86400000).toISOString(),
  );
  rec.evidence = all(
    "SELECT provider,feed,timeframe,window_start AS windowStart,window_end AS windowEnd,revision,evidence_type AS evidenceType,summary_json AS summaryJson,reproducibility,fetched_at AS fetchedAt FROM market_evidence_metadata WHERE symbol=? AND window_start>=? ORDER BY fetched_at DESC LIMIT 20",
    rec.ticker,
    new Date(Date.parse(rec.publishedAt) - 86400000).toISOString(),
  ).map((row) => ({ ...row, summary: json(row.summaryJson, {}), summaryJson: undefined }));
  return rec;
}

function summaryForUser(userId) {
  const totals = get(
    `SELECT
       COUNT(*) AS published,
       SUM(CASE WHEN json_extract(tags_json,'$.fast_momentum_candidate') THEN 1 ELSE 0 END) AS fastMomentumPublished
     FROM recommendations
     WHERE user_id=?`,
    userId,
  ) || {};
  const outcome = get(
    `SELECT
       SUM(CASE WHEN latest.workflow_status='complete' THEN 1 ELSE 0 END) AS complete,
       SUM(CASE WHEN latest.workflow_status IS NULL THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN latest.outcome_status='no_observed_fill' THEN 1 ELSE 0 END) AS noObservedFill,
       SUM(CASE WHEN latest.outcome_status='unresolved' THEN 1 ELSE 0 END) AS unresolved,
       SUM(CASE WHEN latest.outcome_status='ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
       SUM(CASE WHEN latest.outcome_status='target' THEN 1 ELSE 0 END) AS target,
       SUM(CASE WHEN latest.outcome_status='stop' THEN 1 ELSE 0 END) AS stop,
       SUM(CASE WHEN latest.outcome_status='time_exit' THEN 1 ELSE 0 END) AS timeExit
     FROM recommendations r
     LEFT JOIN (
       SELECT e.*
       FROM recommendation_evaluations e
       WHERE e.horizon='plan' AND NOT EXISTS (
         SELECT 1 FROM recommendation_evaluations newer
         WHERE newer.recommendation_id=e.recommendation_id
           AND newer.user_id=e.user_id
           AND newer.horizon=e.horizon
           AND (newer.checked_at>e.checked_at OR (newer.checked_at=e.checked_at AND newer.id>e.id))
       )
     ) latest ON latest.recommendation_id=r.id AND latest.user_id=r.user_id
     WHERE r.user_id=?`,
    userId,
  ) || {};
  const summary = {
    published: Number(totals.published || 0),
    complete: Number(outcome.complete || 0),
    pending: Number(outcome.pending || 0),
    noObservedFill: Number(outcome.noObservedFill || 0),
    unresolved: Number(outcome.unresolved || 0),
    ambiguous: Number(outcome.ambiguous || 0),
    target: Number(outcome.target || 0),
    stop: Number(outcome.stop || 0),
    timeExit: Number(outcome.timeExit || 0),
    fastMomentumPublished: Number(totals.fastMomentumPublished || 0),
    byStrategy: {},
    asOf: new Date().toISOString(),
    evaluatorVersion: evaluator.VERSION,
  };
  const rows = all(
    `SELECT r.strategy, r.strategy_version,
       COUNT(*) AS published,
       SUM(CASE WHEN latest.workflow_status='complete' THEN 1 ELSE 0 END) AS complete,
       SUM(CASE WHEN latest.outcome_status='target' THEN 1 ELSE 0 END) AS target,
       SUM(CASE WHEN latest.outcome_status='stop' THEN 1 ELSE 0 END) AS stop,
       SUM(CASE WHEN latest.outcome_status='no_observed_fill' THEN 1 ELSE 0 END) AS noObservedFill
     FROM recommendations r
     LEFT JOIN (
       SELECT e.*
       FROM recommendation_evaluations e
       WHERE e.horizon='plan' AND NOT EXISTS (
         SELECT 1 FROM recommendation_evaluations newer
         WHERE newer.recommendation_id=e.recommendation_id
           AND newer.user_id=e.user_id
           AND newer.horizon=e.horizon
           AND (newer.checked_at>e.checked_at OR (newer.checked_at=e.checked_at AND newer.id>e.id))
       )
     ) latest ON latest.recommendation_id=r.id AND latest.user_id=r.user_id
     WHERE r.user_id=?
     GROUP BY r.strategy,r.strategy_version`,
    userId,
  );
  for (const row of rows) {
    const key = `${row.strategy}@${row.strategy_version}`;
    summary.byStrategy[key] = {
      published: Number(row.published || 0),
      complete: Number(row.complete || 0),
      target: Number(row.target || 0),
      stop: Number(row.stop || 0),
      noObservedFill: Number(row.noObservedFill || 0),
    };
  }
  return summary;
}

function dueJobs(now = Date.now(), limit = 25, owner = `worker:${process.pid}`) {
  const nowIso = new Date(now).toISOString();
  const jobs = all(
    `SELECT * FROM recommendation_review_jobs
     WHERE state IN ('pending','retryable_error','evaluating') AND due_at<=? AND (next_retry_at IS NULL OR next_retry_at<=?) AND (lease_until IS NULL OR lease_until<=?)
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

function recordShadowCandidate({ scanId, symbol, strategy, decisionAt, reasonCode, selected = false, features = {}, policyVersion = "baseline-v3", now = Date.now() }) {
  if (!scanId || !symbol || !strategy || !decisionAt || !reasonCode) return false;
  const createdAt = new Date(now).toISOString();
  run(
    `INSERT INTO shadow_candidates(id,scan_id,symbol,strategy,decision_at,reason_code,selected,features_json,policy_version,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(scan_id,symbol,strategy)
     DO UPDATE SET reason_code=excluded.reason_code,selected=MAX(shadow_candidates.selected,excluded.selected),features_json=excluded.features_json,policy_version=excluded.policy_version`,
    hash({ scanId, symbol, strategy }).slice(0, 32),
    scanId, symbol, strategy, decisionAt, reasonCode, selected ? 1 : 0, JSON.stringify(features), policyVersion, createdAt,
  );
  return true;
}

function qualityReportForUser(userId) {
  const rows = all(
    `SELECT horizon,workflow_status,outcome_status,COUNT(*) AS count
     FROM recommendation_evaluations
     WHERE user_id=?
     GROUP BY horizon,workflow_status,outcome_status
     ORDER BY horizon,workflow_status,outcome_status`,
    userId,
  );
  return {
    asOf: new Date().toISOString(),
    rows: rows.map((row) => ({
      horizon: row.horizon,
      workflowStatus: row.workflow_status,
      outcomeStatus: row.outcome_status,
      count: Number(row.count || 0),
    })),
    note: "Quality report separates horizons and does not infer profitability or production readiness.",
  };
}

function persistEvidence({ provider, feed, symbol, timeframe, windowStart, windowEnd, revision, evidenceType, summary, fetchedAt }) {
  const checksum = hash(summary);
  run(
    `INSERT INTO market_evidence_metadata(id,provider,feed,symbol,timeframe,window_start,window_end,revision,evidence_type,summary_json,checksum,reproducibility,fetched_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(provider,feed,symbol,window_start,window_end,revision,evidence_type)
     DO UPDATE SET summary_json=excluded.summary_json,checksum=excluded.checksum,reproducibility=excluded.reproducibility,fetched_at=excluded.fetched_at`,
    hash({ provider, feed, symbol, windowStart, windowEnd, revision, evidenceType }).slice(0, 32),
    provider, feed, symbol, timeframe || null, windowStart, windowEnd, revision, evidenceType, JSON.stringify(summary), checksum,
    summary?.complete === true && summary?.partial !== true ? "bounded" : "limited", fetchedAt,
  );
}

function persistCatalysts({ recommendation, news, filings, fetchedAt }) {
  for (const item of news || []) {
    const eventAt = item.datetime || null;
    const relation = eventAt && Date.parse(eventAt) <= Date.parse(recommendation.decisionAt || recommendation.publishedAt)
      ? "decision_evidence"
      : "post_hoc_explanation";
    run(
      `INSERT INTO catalyst_events(id,provider,symbol,event_at,first_seen_at,event_type,source,title,url,relation,payload_json,fetched_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(provider,symbol,event_type,event_at,title) DO UPDATE SET payload_json=excluded.payload_json,fetched_at=excluded.fetched_at,relation=excluded.relation`,
      hash({ provider: "finnhub", symbol: recommendation.ticker, id: item.id, eventAt, title: item.headline }).slice(0, 32),
      "finnhub", recommendation.ticker, eventAt, item.fetchedAt || fetchedAt, "news", item.source || null, item.headline || null, item.url || null, relation, JSON.stringify(item), fetchedAt,
    );
  }
  for (const filing of filings || []) {
    const eventAt = filing.acceptanceDateTime || filing.filingDate || null;
    const relation = eventAt && Date.parse(eventAt) <= Date.parse(recommendation.decisionAt || recommendation.publishedAt)
      ? "decision_evidence"
      : "post_hoc_explanation";
    run(
      `INSERT INTO catalyst_events(id,provider,symbol,event_at,first_seen_at,event_type,source,title,url,relation,payload_json,fetched_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(provider,symbol,event_type,event_at,title) DO UPDATE SET payload_json=excluded.payload_json,fetched_at=excluded.fetched_at,relation=excluded.relation`,
      hash({ provider: "sec", symbol: recommendation.ticker, accessionNumber: filing.accessionNumber }).slice(0, 32),
      "sec", recommendation.ticker, eventAt, filing.firstSeenAt || fetchedAt, filing.form || "filing", "SEC EDGAR", `${filing.form || "SEC filing"} ${filing.accessionNumber || ""}`.trim(), filing.url || null, relation, JSON.stringify(filing), fetchedAt,
    );
  }
}

function persistCorporateActions({ recommendation, result, start, end, fetchedAt }) {
  const status = result.errors?.length ? "provider_error" : result.actions?.length ? "events_found" : "none_observed";
  run(
    `INSERT INTO corporate_action_checks(id,provider,symbol,window_start,window_end,status,actions_json,fetched_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(provider,symbol,window_start,window_end)
     DO UPDATE SET status=excluded.status,actions_json=excluded.actions_json,fetched_at=excluded.fetched_at`,
    hash({ provider: "alpaca", symbol: recommendation.ticker, start, end }).slice(0, 32),
    "alpaca", recommendation.ticker, start, end, status, JSON.stringify(result.actions || []), fetchedAt,
  );
  return status;
}

async function evaluateJob(job, now = Date.now()) {
  const rec = rowToRecommendation(get("SELECT * FROM recommendations WHERE id=? AND user_id=?", job.recommendation_id, job.user_id));
  if (!rec) throw new Error("recommendation_not_found");
  const receipt = get("SELECT * FROM recommendation_receipts WHERE id=? AND user_id=?", job.receipt_id, job.user_id);
  if (!receipt) throw new Error("receipt_not_found");
  const start = receipt.available_at || rec.publishedAt;
  const end = rec.deadline || rec.expiresAt;
  if (!start || !end) throw new Error("missing_window");
  let result;
  const fetchedAt = new Date(now).toISOString();
  if (job.horizon === "plan") {
    const bars = await alpaca.getIntradayBars({
      symbols: [rec.ticker],
      timeframe: "5Min",
      start,
      end: new Date(Date.parse(end) + 300000).toISOString(),
      feed: rec.provenance?.intradayFeed === "sip" ? "sip" : "iex",
      priority: "review",
    });
    result = evaluator.evaluateRecommendation({ recommendation: { ...rec, publishedAt: start }, bars: bars.get(rec.ticker) || [], horizon: job.horizon });
  } else {
    const horizonDays = { d0: 0, d1: 1, d3: 3, d5: 5 }[job.horizon] ?? 0;
    const windowEnd = new Date(Date.parse(start) + Math.max(1, horizonDays + 1) * 86400000).toISOString();
    const [barsDetail, quotesDetail, corporateActions, newsDetail, secDetail] = await Promise.all([
      alpaca.getBarsDetailed({ symbols: [rec.ticker], timeframe: "1Min", start, end: windowEnd, feed: "sip", adjustment: "split", now }),
      alpaca.getHistoricalQuotesDetailed({ symbols: [rec.ticker], start: new Date(Date.parse(start) - 30000).toISOString(), end: new Date(Date.parse(rec.expiresAt || start) + 30000).toISOString(), feed: "sip", pageBudget: 2, priority: "review" }),
      alpaca.getCorporateActionsDetailed({ symbols: [rec.ticker], start: start.slice(0, 10), end: windowEnd.slice(0, 10), pageBudget: 2 }),
      finnhub.getCompanyNewsMetadata({ symbol: rec.ticker, from: new Date(Date.parse(start) - 86400000).toISOString(), to: windowEnd, limit: 25 }),
      sec.getCompanyFilingsMetadata({ symbol: rec.ticker, from: new Date(Date.parse(start) - 86400000).toISOString(), to: windowEnd, limit: 10 }),
    ]);
    persistEvidence({ provider: "alpaca", feed: "sip", symbol: rec.ticker, timeframe: "1Min", windowStart: start, windowEnd, revision: "alpaca:sip:split:1min", evidenceType: "bars", summary: { complete: barsDetail.complete, errors: barsDetail.errors, count: barsDetail.bars.get(rec.ticker)?.length || 0 }, fetchedAt });
    persistEvidence({ provider: "alpaca", feed: "sip", symbol: rec.ticker, timeframe: "quote", windowStart: start, windowEnd: rec.expiresAt || start, revision: "alpaca:sip:quotes", evidenceType: "quotes", summary: { complete: quotesDetail.complete, partial: quotesDetail.partial, pages: quotesDetail.pages, errors: quotesDetail.errors, coverage: quotesDetail.coverage?.[rec.ticker] || {} }, fetchedAt });
    const corporateStatus = persistCorporateActions({ recommendation: rec, result: corporateActions, start: start.slice(0, 10), end: windowEnd.slice(0, 10), fetchedAt });
    persistCatalysts({ recommendation: rec, news: newsDetail.items || [], filings: secDetail.filings || [], fetchedAt });
    result = evaluator.horizonMovement({ recommendation: { ...rec, publishedAt: start }, bars: barsDetail.bars.get(rec.ticker) || [], horizon: job.horizon, timeframe: "1Min" });
    const quote = evaluator.quoteOpportunity({ quotes: quotesDetail.quotes.get(rec.ticker) || [], plan: rec.plan, publishedAt: start });
    result = {
      ...result,
      metrics: { ...result.metrics, quoteObservedEntryOpportunity: quote.observed, spreadBps: quote.spreadBps ?? null, quoteAt: quote.quoteAt || null },
      coverage: {
        ...result.coverage,
        dataRevision: "alpaca:sip:split:1min+quotes",
        quotes: { complete: quotesDetail.complete, partial: quotesDetail.partial, reason: quote.reason || null, count: quote.quoteCount || 0 },
        corporateActions: { status: corporateStatus, count: corporateActions.actions?.length || 0 },
        catalysts: { finnhub: newsDetail.items?.length || 0, sec: secDetail.filings?.length || 0, secError: secDetail.errorKind || null, finnhubError: newsDetail.errorKind || null },
      },
      ambiguity: { ...result.ambiguity, quoteFillIsNotActualFill: true, explanationIsPostHoc: true },
    };
  }
  const checkedAt = new Date(now).toISOString();
  const previous = get(
    "SELECT id FROM recommendation_evaluations WHERE recommendation_id=? AND receipt_id=? AND horizon=? ORDER BY checked_at DESC,id DESC LIMIT 1",
    rec.id, job.receipt_id, job.horizon,
  );
  run(
    `INSERT INTO recommendation_evaluations(id,recommendation_id,receipt_id,user_id,evaluator_version,data_revision,horizon,workflow_status,outcome_status,metrics_json,coverage_json,ambiguity_json,checked_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(recommendation_id,receipt_id,evaluator_version,data_revision,horizon)
     DO UPDATE SET workflow_status=excluded.workflow_status,outcome_status=excluded.outcome_status,metrics_json=excluded.metrics_json,coverage_json=excluded.coverage_json,ambiguity_json=excluded.ambiguity_json,checked_at=excluded.checked_at`,
    hash({ job: job.job_key, version: result.evaluatorVersion }).slice(0, 32), rec.id, job.receipt_id, job.user_id, result.evaluatorVersion,
    result.coverage.dataRevision, job.horizon, result.workflowStatus, result.outcomeStatus, JSON.stringify(result.metrics),
    JSON.stringify(result.coverage), JSON.stringify(result.ambiguity), checkedAt,
  );
  run(
    `INSERT OR IGNORE INTO evaluation_revisions(id,recommendation_id,receipt_id,user_id,evaluator_version,data_revision,previous_evaluation_id,reason,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    hash({ rec: rec.id, receipt: job.receipt_id, version: result.evaluatorVersion, dataRevision: result.coverage.dataRevision, horizon: job.horizon }).slice(0, 32),
    rec.id, job.receipt_id, job.user_id, result.evaluatorVersion, result.coverage.dataRevision, previous?.id || null, `review:${job.horizon}`, checkedAt,
  );
  const nextState = result.workflowStatus === "retryable_error" ? "retryable_error" : "complete";
  const writeResult = run(
    "UPDATE recommendation_review_jobs SET state=?, attempts=attempts+1, next_retry_at=?, lease_owner=NULL, lease_until=NULL, last_error=NULL, updated_at=? WHERE job_key=? AND lease_owner=?",
    nextState,
    nextState === "retryable_error" ? new Date(now + 30 * 60000).toISOString() : null,
    checkedAt,
    job.job_key,
    job.lease_owner,
  );
  if (!writeResult.changes) throw new Error("job_lease_lost");
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
        "UPDATE recommendation_review_jobs SET state='retryable_error', attempts=?, next_retry_at=?, lease_owner=NULL, lease_until=NULL, last_error=?, updated_at=? WHERE job_key=? AND lease_owner=?",
        attempts, new Date(now + delay).toISOString(), error.message, new Date(now).toISOString(), job.job_key, job.lease_owner,
      );
    }
  }
  run(
    "UPDATE recommendation_review_runs SET completed_at=?, counts_json=?, failures_json=? WHERE id=?",
    new Date().toISOString(), JSON.stringify(counts), JSON.stringify(failures), runId,
  );
  return { runId, counts, failures };
}

function listAllForUser(userId, { limit = 10000 } = {}) {
  const safeLimit = Math.min(10000, Math.max(1, Number(limit) || 10000));
  return all(
    `SELECT r.*, ${latestEvaluationSelect()} FROM recommendations r WHERE r.user_id=? ORDER BY r.published_at DESC,r.id DESC LIMIT ?`,
    userId, safeLimit,
  ).map((row) => ({
    ...rowToRecommendation(row),
    evaluation: json(row.evaluation_json, null),
  }));
}

function flushOutbox(notices, now = Date.now()) {
  const rows = all(
    `SELECT o.*, r.ticker, r.strategy
     FROM recommendation_outbox o
     JOIN recommendations r ON r.id=o.recommendation_id
     WHERE o.delivered_at IS NULL AND o.attempts < 5
     ORDER BY o.created_at ASC
     LIMIT 30`,
  );
  const deliveredAt = new Date(now).toISOString();
  for (const row of rows) {
    const payload = json(row.payload_json, {});
    const eventId = payload.signalId ? `signal:${payload.signalId}` : `recommendation:${row.id}`;
    try {
      notices.event(
        row.user_id,
        eventId,
        `${row.ticker} · ${row.strategy}`,
        "המלצה חדשה נשמרה בארכיון המעקב. בדוק זמינות ומחיר אצל הברוקר לפני פעולה.",
        "signal",
      );
      run("UPDATE recommendation_outbox SET delivered_at=?, attempts=attempts+1 WHERE id=? AND delivered_at IS NULL", deliveredAt, row.id);
    } catch (error) {
      run("UPDATE recommendation_outbox SET attempts=attempts+1 WHERE id=?", row.id);
    }
  }
  return rows.length;
}

module.exports = {
  REVIEW_HORIZONS,
  archiveSignal,
  updateLifecycle,
  listForUser,
  getForUser,
  summaryForUser,
  dueJobs,
  recordShadowCandidate,
  qualityReportForUser,
  evaluateJob,
  runDue,
  listAllForUser,
  flushOutbox,
  fastMomentumTags,
};
