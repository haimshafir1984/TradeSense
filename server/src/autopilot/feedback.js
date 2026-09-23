const crypto = require("node:crypto");
const store = require("./store");

const BASELINE_POLICY_VERSION = "baseline-v3";
const FEATURE_SCHEMA_VERSION = "feedback-compact-v1";
const GATE_VERSION = "feedback-gates-v1";
const DEFAULT_GATES = {
  minForwardSessions: 30,
  minResolvedSetups: 100,
  minPriceCoveragePct: 90,
  maxNoFillPct: 70,
  maxAmbiguousPct: 20,
};

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

function db() {
  return store.database();
}

function run(stmt, ...args) {
  return db().prepare(stmt).run(...args);
}

function get(stmt, ...args) {
  return db().prepare(stmt).get(...args);
}

function all(stmt, ...args) {
  return db().prepare(stmt).all(...args);
}

function activePolicy() {
  const row = get(
    "SELECT * FROM policy_candidates WHERE state IN ('active_limited','shadow','eligible_for_limited_activation') ORDER BY CASE state WHEN 'active_limited' THEN 0 WHEN 'eligible_for_limited_activation' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1",
  );
  if (!row) return baselinePolicy();
  return {
    policyVersion: row.policy_version,
    state: row.state,
    featureSchemaVersion: row.feature_schema_version,
    hyperparams: json(row.hyperparams_json, {}),
    evidence: json(row.evidence_json, {}),
    previousPolicyVersion: row.previous_policy_version || BASELINE_POLICY_VERSION,
    gateVersion: row.gate_version,
  };
}

function baselinePolicy() {
  return {
    policyVersion: BASELINE_POLICY_VERSION,
    state: "baseline",
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    hyperparams: {},
    evidence: {},
    gateVersion: GATE_VERSION,
  };
}

function numericBucket(value, cuts) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "missing";
  for (const cut of cuts) if (n < cut) return `<${cut}`;
  return `>=${cuts.at(-1)}`;
}

function scoreCandidate(row, policy = activePolicy()) {
  if (policy.state !== "active_limited") {
    return { applied: false, policyVersion: policy.policyVersion, reason: `policy_${policy.state}`, priorityScore: null };
  }
  const daily = row.daily || {};
  const rvol = Number(row.score ?? row.rvol ?? row.features?.rvol);
  const adv = Number(row.avgDollarVolume20d ?? daily.avgDollarVolume20d);
  const atrPct = daily.atr14 && daily.price ? (daily.atr14 / daily.price) * 100 : Number(row.features?.atrPct);
  const hourBucket = numericBucket(row.decisionHourNy, [10, 11, 12, 14, 16]);
  const rvolBucket = numericBucket(rvol, [1.5, 2, 3, 5]);
  const liquidityBucket = adv < 20_000_000 ? "lower" : adv < 100_000_000 ? "medium" : "high";
  const weights = {
    rvol: 1,
    liquidity: 0.25,
    atr: 0.5,
    freshness: 0.1,
    ...(policy.hyperparams?.weights || {}),
  };
  const missingness = [rvol, adv, atrPct].filter((value) => !Number.isFinite(value)).length;
  const priorityScore =
    (Number.isFinite(rvol) ? Math.min(6, rvol) * weights.rvol : -1) +
    (liquidityBucket === "medium" ? weights.liquidity : liquidityBucket === "high" ? weights.liquidity / 2 : -weights.liquidity) +
    (Number.isFinite(atrPct) ? Math.min(10, atrPct) * weights.atr / 10 : -0.5) -
    missingness * 0.35;
  return {
    applied: true,
    policyVersion: policy.policyVersion,
    featureSchemaVersion: policy.featureSchemaVersion,
    priorityScore,
    evidenceCount: Number(policy.evidence?.resolvedSetups || 0),
    uncertainty: policy.evidence?.uncertainty || "unknown",
    missingness,
    buckets: { rvolBucket, liquidityBucket, hourBucket },
  };
}

function maybeApplyPolicyToList(list, policy = activePolicy()) {
  if (policy.state !== "active_limited") return { rows: list, applied: false, policyVersion: policy.policyVersion, reason: `policy_${policy.state}` };
  const scored = list.map((row, index) => ({ row, index, score: scoreCandidate(row, policy) }));
  scored.sort((left, right) =>
    (right.score.priorityScore ?? -Infinity) - (left.score.priorityScore ?? -Infinity) ||
    left.index - right.index ||
    left.row.symbol.localeCompare(right.row.symbol),
  );
  return {
    rows: scored.map((item, index) => ({
      ...item.row,
      feedbackPolicy: item.score,
      baselineRank: item.index + 1,
      policyRank: index + 1,
    })),
    applied: true,
    policyVersion: policy.policyVersion,
    reason: "active_limited",
  };
}

function recordSelectionDecision({ scanId, row, strategy, selected, baselineRank, policyRank, reasonCode, policyVersion, decisionAt = new Date().toISOString() }) {
  if (!scanId || !row?.symbol || !strategy) return false;
  const setupId = `${decisionAt.slice(0, 10)}:${row.symbol}:${strategy}`;
  const createdAt = new Date().toISOString();
  run(
    `INSERT INTO selection_decisions(id,scan_id,setup_id,symbol,strategy,lane,selected,baseline_rank,policy_rank,policy_version,reason_code,features_json,decision_at,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(scan_id,setup_id,policy_version)
     DO UPDATE SET selected=excluded.selected,policy_rank=excluded.policy_rank,reason_code=excluded.reason_code,features_json=excluded.features_json`,
    hash({ scanId, setupId, policyVersion }).slice(0, 32),
    scanId,
    setupId,
    row.symbol,
    strategy,
    ["orb15", "gap_pullback", "vwap_reclaim"].includes(strategy) ? "day" : "swing",
    selected ? 1 : 0,
    baselineRank ?? null,
    policyRank ?? null,
    policyVersion || BASELINE_POLICY_VERSION,
    reasonCode || null,
    JSON.stringify({
      avgDollarVolume20d: row.avgDollarVolume20d ?? row.daily?.avgDollarVolume20d ?? null,
      score: row.score ?? null,
      rvol: row.rvol ?? null,
      atrPct: row.daily?.atr14 && row.daily?.price ? (row.daily.atr14 / row.daily.price) * 100 : null,
      selectedFor: row.selectedFor || null,
      feedbackPolicy: row.feedbackPolicy || null,
    }),
    decisionAt,
    createdAt,
  );
  return true;
}

function latestEvaluationCte(horizon) {
  return `SELECT e.*
    FROM recommendation_evaluations e
    WHERE e.horizon='${horizon.replace(/'/g, "''")}' AND NOT EXISTS (
      SELECT 1 FROM recommendation_evaluations newer
      WHERE newer.recommendation_id=e.recommendation_id
        AND COALESCE(newer.receipt_id,'')=COALESCE(e.receipt_id,'')
        AND newer.horizon=e.horizon
        AND (newer.checked_at>e.checked_at OR (newer.checked_at=e.checked_at AND newer.id>e.id))
    )`;
}

function buildDataset({ asOf = new Date().toISOString(), horizon = "d5", policyVersion = BASELINE_POLICY_VERSION } = {}) {
  const recRows = all(
    `SELECT r.*, e.workflow_status,e.outcome_status,e.metrics_json,e.coverage_json,e.evaluator_version,e.data_revision,e.checked_at
     FROM recommendations r
     LEFT JOIN (${latestEvaluationCte(horizon)}) e ON e.recommendation_id=r.id AND e.user_id=r.user_id
     WHERE r.published_at<=?
     ORDER BY r.published_at ASC,r.id ASC`,
    asOf,
  );
  const shadowRows = all("SELECT * FROM shadow_candidates WHERE decision_at<=? ORDER BY decision_at ASC,id ASC", asOf);
  const setupRows = [];
  const seen = new Set();
  for (const row of recRows) {
    const plan = json(row.plan_json, {});
    const features = json(row.features_json, {});
    const setupId = `${row.session_date || row.published_at.slice(0, 10)}:${row.ticker}:${row.strategy}:${hash({ plan, decisionAt: row.decision_at }).slice(0, 10)}`;
    if (seen.has(setupId)) continue;
    seen.add(setupId);
    setupRows.push({
      setupId,
      recommendationId: row.id,
      shadowCandidateId: null,
      symbol: row.ticker,
      strategy: row.strategy,
      decisionAt: row.decision_at || row.published_at,
      features,
      label: {
        horizon,
        workflowStatus: row.workflow_status || "pending",
        outcomeStatus: row.outcome_status || "pending",
        metrics: json(row.metrics_json, {}),
        evaluatorVersion: row.evaluator_version || null,
        dataRevision: row.data_revision || null,
        checkedAt: row.checked_at || null,
      },
      coverageStatus: json(row.coverage_json, {})?.coverageStatus || row.workflow_status || "pending",
      sampleWeight: 1,
    });
  }
  for (const row of shadowRows) {
    const setupId = `${row.scan_id}:${row.symbol}:${row.strategy}`;
    if (seen.has(setupId)) continue;
    seen.add(setupId);
    setupRows.push({
      setupId,
      recommendationId: null,
      shadowCandidateId: row.id,
      symbol: row.symbol,
      strategy: row.strategy,
      decisionAt: row.decision_at,
      features: json(row.features_json, {}),
      label: { horizon, workflowStatus: "unlabeled", outcomeStatus: "unlabeled" },
      coverageStatus: "unlabeled",
      sampleWeight: row.selected ? 1 : 0.25,
    });
  }
  const counts = setupRows.reduce((acc, row) => {
    acc.total += 1;
    acc[row.coverageStatus] = (acc[row.coverageStatus] || 0) + 1;
    if (row.recommendationId) acc.publishedUniqueSetups += 1;
    if (row.shadowCandidateId) acc.shadowCandidates += 1;
    return acc;
  }, { total: 0, publishedUniqueSetups: 0, shadowCandidates: 0 });
  const coverage = {
    complete: setupRows.filter((row) => row.label.workflowStatus === "complete").length,
    pending: setupRows.filter((row) => row.label.workflowStatus === "pending").length,
    needsData: setupRows.filter((row) => ["retryable_error", "needs_data"].includes(row.label.workflowStatus)).length,
    unlabeled: setupRows.filter((row) => row.label.workflowStatus === "unlabeled").length,
  };
  const checksum = hash(setupRows);
  const datasetVersion = `feedback:${horizon}:${asOf.slice(0, 10)}:${checksum.slice(0, 12)}`;
  const datasetId = hash({ datasetVersion }).slice(0, 32);
  const createdAt = new Date().toISOString();
  store.transaction(() => {
    run(
      `INSERT INTO feedback_datasets(id,dataset_version,as_of,label_horizon,policy_version,counts_json,coverage_json,checksum,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(dataset_version) DO UPDATE SET counts_json=excluded.counts_json,coverage_json=excluded.coverage_json,checksum=excluded.checksum`,
      datasetId, datasetVersion, asOf, horizon, policyVersion, JSON.stringify(counts), JSON.stringify(coverage), checksum, createdAt,
    );
    for (const row of setupRows) {
      run(
        `INSERT INTO feedback_dataset_rows(id,dataset_id,setup_id,recommendation_id,shadow_candidate_id,symbol,strategy,decision_at,feature_snapshot_json,label_json,coverage_status,sample_weight,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(dataset_id,setup_id) DO UPDATE SET label_json=excluded.label_json,coverage_status=excluded.coverage_status,feature_snapshot_json=excluded.feature_snapshot_json`,
        hash({ datasetId, setupId: row.setupId }).slice(0, 32),
        datasetId,
        row.setupId,
        row.recommendationId,
        row.shadowCandidateId,
        row.symbol,
        row.strategy,
        row.decisionAt,
        JSON.stringify(row.features),
        JSON.stringify(row.label),
        row.coverageStatus,
        row.sampleWeight,
        createdAt,
      );
    }
  });
  return { datasetId, datasetVersion, asOf, horizon, counts, coverage, checksum };
}

function ensureShadowPolicy({ now = new Date().toISOString() } = {}) {
  const existing = get("SELECT * FROM policy_candidates WHERE policy_version='feedback-simple-shadow-v1'");
  if (existing) return activePolicy();
  run(
    `INSERT INTO policy_candidates(policy_version,state,feature_schema_version,hyperparams_json,training_dataset_version,train_cutoff_at,gate_version,evidence_json,previous_policy_version,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    "feedback-simple-shadow-v1",
    "shadow",
    FEATURE_SCHEMA_VERSION,
    JSON.stringify({ weights: { rvol: 1, liquidity: 0.25, atr: 0.5 } }),
    null,
    null,
    GATE_VERSION,
    JSON.stringify({ reason: "created_for_prospective_shadow", gates: DEFAULT_GATES }),
    BASELINE_POLICY_VERSION,
    now,
    now,
  );
  return activePolicy();
}

function evaluateGates({ policyVersion = "feedback-simple-shadow-v1", datasetVersion } = {}) {
  const dataset = datasetVersion
    ? get("SELECT * FROM feedback_datasets WHERE dataset_version=?", datasetVersion)
    : get("SELECT * FROM feedback_datasets ORDER BY created_at DESC LIMIT 1");
  const counts = json(dataset?.counts_json, {});
  const coverage = json(dataset?.coverage_json, {});
  const resolvedSetups = Number(coverage.complete || 0);
  const priceCoveragePct = counts.total ? (Number(coverage.complete || 0) / counts.total) * 100 : 0;
  const gates = {
    ...DEFAULT_GATES,
    resolvedSetups,
    priceCoveragePct,
    forwardSessions: 0,
  };
  const passed = resolvedSetups >= gates.minResolvedSetups && priceCoveragePct >= gates.minPriceCoveragePct && gates.forwardSessions >= gates.minForwardSessions;
  const decision = passed ? "eligible_for_limited_activation" : "shadow_insufficient_evidence";
  const reason = passed ? "all_predefined_gates_passed" : "not_enough_forward_evidence_or_coverage";
  const createdAt = new Date().toISOString();
  run(
    "INSERT INTO policy_evaluations(id,policy_version,dataset_version,stage,metrics_json,gates_json,decision,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    hash({ policyVersion, datasetVersion: dataset?.dataset_version || null, createdAt }).slice(0, 32),
    policyVersion,
    dataset?.dataset_version || null,
    "gate_check",
    JSON.stringify({ resolvedSetups, priceCoveragePct, counts, coverage }),
    JSON.stringify(gates),
    decision,
    reason,
    createdAt,
  );
  run(
    "UPDATE policy_candidates SET evidence_json=?, updated_at=? WHERE policy_version=?",
    JSON.stringify({ resolvedSetups, priceCoveragePct, gates, decision, reason }),
    createdAt,
    policyVersion,
  );
  return { policyVersion, datasetVersion: dataset?.dataset_version || null, decision, reason, gates, metrics: { resolvedSetups, priceCoveragePct } };
}

function rollbackPolicy({ reason = "quality_gate_failed", now = new Date().toISOString() } = {}) {
  const active = get("SELECT * FROM policy_candidates WHERE state='active_limited' ORDER BY updated_at DESC LIMIT 1");
  if (!active) return { rolledBack: false, reason: "no_active_limited_policy" };
  run("UPDATE policy_candidates SET state='rolled_back',updated_at=? WHERE policy_version=?", now, active.policy_version);
  run(
    "INSERT INTO policy_activations(id,policy_version,state,reason,previous_policy_version,activated_at,rollback_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
    hash({ policyVersion: active.policy_version, rollbackAt: now }).slice(0, 32),
    active.policy_version,
    "rolled_back",
    reason,
    active.previous_policy_version || BASELINE_POLICY_VERSION,
    null,
    now,
    now,
  );
  return { rolledBack: true, policyVersion: active.policy_version, reason };
}

function status() {
  ensureShadowPolicy();
  const policy = activePolicy();
  const latestDataset = get("SELECT * FROM feedback_datasets ORDER BY created_at DESC LIMIT 1");
  const latestEvaluation = get("SELECT * FROM policy_evaluations ORDER BY created_at DESC LIMIT 1");
  const activations = all("SELECT * FROM policy_activations ORDER BY created_at DESC LIMIT 10");
  return {
    asOf: new Date().toISOString(),
    baselinePolicyVersion: BASELINE_POLICY_VERSION,
    activePolicy: policy,
    dataset: latestDataset ? {
      datasetVersion: latestDataset.dataset_version,
      asOf: latestDataset.as_of,
      horizon: latestDataset.label_horizon,
      counts: json(latestDataset.counts_json, {}),
      coverage: json(latestDataset.coverage_json, {}),
      checksum: latestDataset.checksum,
    } : null,
    latestGateCheck: latestEvaluation ? {
      policyVersion: latestEvaluation.policy_version,
      datasetVersion: latestEvaluation.dataset_version,
      decision: latestEvaluation.decision,
      reason: latestEvaluation.reason,
      metrics: json(latestEvaluation.metrics_json, {}),
      gates: json(latestEvaluation.gates_json, {}),
      createdAt: latestEvaluation.created_at,
    } : null,
    activations: activations.map((row) => ({
      policyVersion: row.policy_version,
      state: row.state,
      reason: row.reason,
      previousPolicyVersion: row.previous_policy_version,
      activatedAt: row.activated_at,
      rollbackAt: row.rollback_at,
      createdAt: row.created_at,
    })),
    note: policy.state === "active_limited"
      ? "Limited ranking policy is active only inside existing eligible selection pools."
      : "Feedback is measuring and comparing in shadow; it is not changing live ranking.",
  };
}

module.exports = {
  BASELINE_POLICY_VERSION,
  FEATURE_SCHEMA_VERSION,
  GATE_VERSION,
  activePolicy,
  ensureShadowPolicy,
  scoreCandidate,
  maybeApplyPolicyToList,
  recordSelectionDecision,
  buildDataset,
  evaluateGates,
  rollbackPolicy,
  status,
};
