const crypto = require("node:crypto");
const store = require("./store");
const market = require("./market");

const BASELINE_POLICY_VERSION = "baseline-v3";
const SHADOW_POLICY_VERSION = "feedback-simple-shadow-v1";
const FEATURE_SCHEMA_VERSION = "feedback-snapshot-v2";
const GATE_VERSION = "feedback-gates-v2";
const LEARNER_VERSION = "bucket-outcome-v2";
const DEFAULT_GATES = {
  minForwardSessions: 7,
  minResolvedSetups: 20,
  minProspectiveResolvedSetups: 20,
  minPriceCoveragePct: 70,
  maxNoFillPct: 70,
  maxAmbiguousPct: 20,
  requireReplayComplete: true,
  requireValidationAdvantage: true,
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

function tradingSessionsSince(startAt, asOf = new Date().toISOString()) {
  const start = Date.parse(startAt);
  const end = Date.parse(asOf);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return market.cachedSessionsRange(start, end)
    .filter((session) => session.close > start && session.close <= end)
    .length;
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
  if (value == null) return "missing";
  const n = Number(value);
  if (!Number.isFinite(n)) return "missing";
  for (const cut of cuts) if (n < cut) return `<${cut}`;
  return `>=${cuts.at(-1)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function missingMaskFor(snapshot) {
  return Object.fromEntries(["rvol", "gapPct", "atrPct", "adv20", "decisionHourNy", "priceFreshnessMs"].map((key) => [key, snapshot[key] == null]));
}

function featureSchemaCompatible(snapshot = {}) {
  return snapshot.featureSchemaVersion === FEATURE_SCHEMA_VERSION;
}

function candidateFeatureSnapshot(row = {}, strategy = row.selectedFor || row.candidateFor || row.strategy) {
  const daily = row.daily || {};
  const features = row.features || {};
  const rvol = finiteOrNull(row.rvol ?? features.rvol);
  const adv20 = finiteOrNull(row.avgDollarVolume20d ?? daily.avgDollarVolume20d ?? features.adv20 ?? features.avgDollarVolume20d);
  const atrPct = daily.atr14 && daily.price ? finiteOrNull((daily.atr14 / daily.price) * 100) : finiteOrNull(features.atrPct);
  const gapPct = finiteOrNull(row.gapPct ?? features.gapPct);
  const decisionAt = row.decisionAt || row.decision_at || features.decisionAt || null;
  const decisionTime = Date.parse(decisionAt);
  const decisionHourNy = finiteOrNull(row.decisionHourNy ?? features.decisionHourNy ?? (Number.isFinite(decisionTime) ? Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit" }).format(new Date(decisionTime))) : null));
  const priceFreshnessMs = finiteOrNull(row.priceFreshnessMs ?? features.priceFreshnessMs);
  const featureAvailableAt = row.featureAvailableAt || features.featureAvailableAt || decisionAt;
  const snapshot = {
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    strategy: strategy || features.strategy || "unknown",
    strategyVersion: row.strategyVersion || row.version || features.strategyVersion || null,
    lane: row.lane || features.lane || (["orb15", "gap_pullback", "vwap_reclaim"].includes(strategy) ? "day" : "swing"),
    decisionAt,
    featureAvailableAt,
    rvol,
    gapPct,
    atrPct,
    adv20,
    decisionHourNy,
    priceFreshnessMs,
    sourceVersions: {
      dailyFeed: row.provenance?.dailyFeed || features.sourceVersions?.dailyFeed || null,
      intradayFeed: row.provenance?.intradayFeed || features.sourceVersions?.intradayFeed || null,
      priceFeed: row.provenance?.priceFeed || features.sourceVersions?.priceFeed || null,
    },
  };
  snapshot.missingMask = missingMaskFor(snapshot);
  return {
    ...snapshot,
    schemaCompatible: true,
  };
}

function featureBuckets(snapshot) {
  const strategy = snapshot.strategy || "unknown";
  return [
    `strategy:${strategy}`,
    `strategy:${strategy}|rvol:${numericBucket(snapshot.rvol, [1, 1.5, 2, 3, 5])}`,
    `strategy:${strategy}|atrPct:${numericBucket(snapshot.atrPct, [1, 2, 3, 5, 8])}`,
    `strategy:${strategy}|liquidity:${numericBucket(snapshot.adv20, [20_000_000, 100_000_000, 500_000_000])}`,
    `strategy:${strategy}|gapPct:${numericBucket(snapshot.gapPct, [-3, 0, 2, 5, 10])}`,
  ];
}

function labelValue(label = {}) {
  if (label.workflowStatus !== "complete") return null;
  if (["no_observed_fill", "ambiguous", "unresolved"].includes(label.outcomeStatus)) return null;
  const metrics = label.metrics || {};
  if (metrics.returnFromObservedReferencePct != null && Number.isFinite(Number(metrics.returnFromObservedReferencePct))) {
    return clamp(Number(metrics.returnFromObservedReferencePct) / 5, -2, 2);
  }
  if (metrics.rNet != null && Number.isFinite(Number(metrics.rNet))) return clamp(Number(metrics.rNet), -2, 2);
  if (metrics.netReturnPct != null && Number.isFinite(Number(metrics.netReturnPct))) return clamp(Number(metrics.netReturnPct) / 5, -2, 2);
  const map = {
    target: 1,
    time_exit: 0,
    invalidated_before_entry: -1,
    stop: -1,
  };
  return Object.prototype.hasOwnProperty.call(map, label.outcomeStatus) ? map[label.outcomeStatus] : null;
}

function scoreCandidate(row, policy = activePolicy()) {
  if (policy.state !== "active_limited") {
    return { applied: false, policyVersion: policy.policyVersion, reason: `policy_${policy.state}`, priorityScore: null };
  }
  const snapshot = candidateFeatureSnapshot(row);
  const featureAvailable = Date.parse(snapshot.featureAvailableAt || 0);
  const decisionAt = Date.parse(snapshot.decisionAt || row.decisionAt || row.decision_at || 0);
  if (!featureSchemaCompatible(snapshot) || (Number.isFinite(featureAvailable) && Number.isFinite(decisionAt) && featureAvailable > decisionAt)) {
    return { applied: false, policyVersion: policy.policyVersion, reason: "feature_snapshot_unusable", priorityScore: null };
  }
  const rvol = snapshot.rvol;
  const adv = snapshot.adv20;
  const atrPct = snapshot.atrPct;
  const hourBucket = numericBucket(row.decisionHourNy, [10, 11, 12, 14, 16]);
  const rvolBucket = numericBucket(rvol, [1.5, 2, 3, 5]);
  const liquidityBucket = adv == null ? "missing" : adv < 20_000_000 ? "lower" : adv < 100_000_000 ? "medium" : "high";
  const bucketEffects = policy.hyperparams?.bucketEffects || {};
  const learnedBase = Number(policy.hyperparams?.globalMean || 0);
  const learnedScore = featureBuckets(snapshot).reduce((sum, bucket) => sum + Number(bucketEffects[bucket] || 0), learnedBase);
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
    (liquidityBucket === "medium" ? weights.liquidity : liquidityBucket === "high" ? weights.liquidity / 2 : liquidityBucket === "missing" ? -0.5 : -weights.liquidity) +
    (Number.isFinite(atrPct) ? Math.min(10, atrPct) * weights.atr / 10 : -0.5) +
    learnedScore * Number(policy.hyperparams?.learnedScoreScale ?? 3) -
    missingness * 0.35;
  return {
    applied: true,
    policyVersion: policy.policyVersion,
    featureSchemaVersion: policy.featureSchemaVersion,
    priorityScore,
    learnedScore,
    evidenceCount: Number(policy.evidence?.resolvedSetups || 0),
    uncertainty: policy.evidence?.uncertainty || "unknown",
    missingness,
    missingMask: snapshot.missingMask,
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
  const shadowPolicy = get("SELECT * FROM policy_candidates WHERE policy_version=?", SHADOW_POLICY_VERSION);
  const shadowStartedAt = shadowPolicy?.created_at || null;
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
    const snapshot = featureSchemaCompatible(features)
      ? features
      : { ...features, featureSchemaVersion: features.featureSchemaVersion || "legacy_or_unknown", schemaCompatible: false, schemaReason: "schema_incompatible" };
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
      features: snapshot,
      label: {
        horizon,
        workflowStatus: row.workflow_status || "pending",
        outcomeStatus: row.outcome_status || "pending",
        metrics: json(row.metrics_json, {}),
        evaluatorVersion: row.evaluator_version || null,
        dataRevision: row.data_revision || null,
        checkedAt: row.checked_at || null,
      },
      coverageStatus: snapshot.schemaCompatible === false ? "schema_incompatible" : json(row.coverage_json, {})?.coverageStatus || row.workflow_status || "pending",
      sampleWeight: 1,
    });
  }
  for (const row of shadowRows) {
    const rawFeatures = json(row.features_json, {});
    const snapshot = featureSchemaCompatible(rawFeatures)
      ? rawFeatures
      : { ...rawFeatures, featureSchemaVersion: rawFeatures.featureSchemaVersion || "legacy_or_unknown", schemaCompatible: false, schemaReason: "schema_incompatible" };
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
      features: snapshot,
      label: { horizon, workflowStatus: "unlabeled", outcomeStatus: "unlabeled" },
      coverageStatus: snapshot.schemaCompatible === false ? "schema_incompatible" : "unlabeled",
      sampleWeight: row.selected ? 1 : 0.25,
    });
  }
  const counts = setupRows.reduce((acc, row) => {
    acc.total += 1;
    acc[row.coverageStatus] = (acc[row.coverageStatus] || 0) + 1;
    if (row.recommendationId) acc.publishedUniqueSetups += 1;
    if (row.shadowCandidateId) acc.shadowCandidates += 1;
    if (row.decisionAt && shadowStartedAt && Date.parse(row.decisionAt) >= Date.parse(shadowStartedAt)) acc.prospectiveSetups += 1;
    if (row.coverageStatus === "schema_incompatible") acc.schemaIncompatible += 1;
    return acc;
  }, { total: 0, publishedUniqueSetups: 0, shadowCandidates: 0, prospectiveSetups: 0, schemaIncompatible: 0, shadowStartedAt });
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
       ON CONFLICT(dataset_version) DO NOTHING`,
      datasetId, datasetVersion, asOf, horizon, policyVersion, JSON.stringify(counts), JSON.stringify(coverage), checksum, createdAt,
    );
    for (const row of setupRows) {
      run(
        `INSERT INTO feedback_dataset_rows(id,dataset_id,setup_id,recommendation_id,shadow_candidate_id,symbol,strategy,decision_at,feature_snapshot_json,label_json,coverage_status,sample_weight,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(dataset_id,setup_id) DO NOTHING`,
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
  const existing = get("SELECT * FROM policy_candidates WHERE policy_version=?", SHADOW_POLICY_VERSION);
  if (existing) return activePolicy();
  run(
    `INSERT INTO policy_candidates(policy_version,state,feature_schema_version,hyperparams_json,training_dataset_version,train_cutoff_at,gate_version,evidence_json,previous_policy_version,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    SHADOW_POLICY_VERSION,
    "shadow",
    FEATURE_SCHEMA_VERSION,
    JSON.stringify({ weights: { rvol: 1, liquidity: 0.25, atr: 0.5 } }),
    null,
    null,
    GATE_VERSION,
    JSON.stringify({ reason: "created_for_prospective_shadow", gates: DEFAULT_GATES, activationWindow: { tradingSessions: DEFAULT_GATES.minForwardSessions, startedAt: now } }),
    BASELINE_POLICY_VERSION,
    now,
    now,
  );
  return activePolicy();
}

function datasetOutcomeMetrics(dataset, counts, coverage) {
  const rows = dataset
    ? all("SELECT decision_at,label_json FROM feedback_dataset_rows WHERE dataset_id=?", dataset.id)
    : [];
  const labels = rows.map((row) => json(row.label_json, {}));
  const rowsWithLabels = rows.map((row) => ({ ...row, label: json(row.label_json, {}) }));
  const resolved = rowsWithLabels.filter((row) => row.label.workflowStatus === "complete");
  const policy = get("SELECT created_at FROM policy_candidates WHERE policy_version=?", SHADOW_POLICY_VERSION);
  const shadowStartedAt = Date.parse(counts.shadowStartedAt || policy?.created_at || 0);
  const prospectiveResolved = rowsWithLabels.filter((row) => row.label.workflowStatus === "complete" && Number.isFinite(shadowStartedAt) && Date.parse(row.decision_at) >= shadowStartedAt);
  const noFill = resolved.filter((row) => row.label.outcomeStatus === "no_observed_fill").length;
  const ambiguous = resolved.filter((row) => row.label.outcomeStatus === "ambiguous").length;
  const resolvedSetups = Number(coverage.complete || resolved.length || 0);
  const priceCoverageBase = Math.max(1, Number(counts.publishedUniqueSetups || counts.total || 0));
  const validation = dataset ? json(dataset.coverage_json, {})?.validation || {} : {};
  const replay = dataset ? json(dataset.coverage_json, {})?.replay || {} : {};
  return {
    resolvedSetups,
    prospectiveResolvedSetups: prospectiveResolved.length,
    priceCoveragePct: (resolvedSetups / priceCoverageBase) * 100,
    noFillPct: resolvedSetups ? (noFill / resolvedSetups) * 100 : 0,
    ambiguousPct: resolvedSetups ? (ambiguous / resolvedSetups) * 100 : 0,
    replayComplete: replay.status === "complete",
    validationAdvantage: validation.advantage === true,
  };
}

function trainLearnedPolicy({ datasetVersion, now = new Date().toISOString(), previousPolicyVersion = SHADOW_POLICY_VERSION } = {}) {
  const dataset = datasetVersion
    ? get("SELECT * FROM feedback_datasets WHERE dataset_version=?", datasetVersion)
    : get("SELECT * FROM feedback_datasets ORDER BY created_at DESC LIMIT 1");
  if (!dataset) return { trained: false, reason: "dataset_missing" };
  const rows = all("SELECT strategy,feature_snapshot_json,label_json FROM feedback_dataset_rows WHERE dataset_id=? AND recommendation_id IS NOT NULL", dataset.id);
  const examples = rows
    .map((row) => ({
      strategy: row.strategy,
      features: json(row.feature_snapshot_json, {}),
      label: json(row.label_json, {}),
    }))
    .map((row) => ({
      snapshot: featureSchemaCompatible(row.features) ? row.features : { ...row.features, schemaCompatible: false },
      value: labelValue(row.label),
    }))
    .filter((row) => featureSchemaCompatible(row.snapshot) && Number.isFinite(row.value));
  if (examples.length < DEFAULT_GATES.minResolvedSetups) {
    return { trained: false, reason: "not_enough_labeled_examples", labeledExamples: examples.length };
  }
  const globalMean = examples.reduce((sum, row) => sum + row.value, 0) / examples.length;
  const prior = 5;
  const bucketStats = {};
  for (const example of examples) {
    for (const bucket of featureBuckets(example.snapshot)) {
      bucketStats[bucket] ||= { count: 0, sum: 0 };
      bucketStats[bucket].count += 1;
      bucketStats[bucket].sum += example.value;
    }
  }
  const bucketEffects = {};
  for (const [bucket, stat] of Object.entries(bucketStats)) {
    const smoothedMean = (stat.sum + globalMean * prior) / (stat.count + prior);
    bucketEffects[bucket] = Number(clamp(smoothedMean - globalMean, -1.5, 1.5).toFixed(6));
  }
  const hyperparams = {
    learner: LEARNER_VERSION,
    labelHorizon: dataset.label_horizon,
    datasetVersion: dataset.dataset_version,
    globalMean: Number(globalMean.toFixed(6)),
    bucketEffects,
    learnedScoreScale: 3,
    prior,
    labeledExamples: examples.length,
  };
  const policyVersion = `feedback-learned-${dataset.as_of.slice(0, 10)}-${hash(hyperparams).slice(0, 10)}`;
  run(
    `INSERT INTO policy_candidates(policy_version,state,feature_schema_version,hyperparams_json,training_dataset_version,train_cutoff_at,gate_version,evidence_json,previous_policy_version,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(policy_version) DO UPDATE SET hyperparams_json=excluded.hyperparams_json,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`,
    policyVersion,
    "eligible_for_limited_activation",
    FEATURE_SCHEMA_VERSION,
    JSON.stringify(hyperparams),
    dataset.dataset_version,
    now,
    GATE_VERSION,
    JSON.stringify({ learner: LEARNER_VERSION, labeledExamples: examples.length, globalMean, learnedBuckets: Object.keys(bucketEffects).length }),
    previousPolicyVersion,
    now,
    now,
  );
  return { trained: true, policyVersion, hyperparams };
}

function activatePolicy({ policyVersion = SHADOW_POLICY_VERSION, datasetVersion, reason = "automatic_after_feedback_gates", now = new Date().toISOString() } = {}) {
  return store.transaction(() => {
    const row = get("SELECT * FROM policy_candidates WHERE policy_version=?", policyVersion);
    if (!row) return { activated: false, reason: "policy_missing" };
    if (row.state === "active_limited") return { activated: false, reason: "already_active_limited", policyVersion };
    if (row.state !== "shadow" && row.state !== "eligible_for_limited_activation") return { activated: false, reason: `policy_state_${row.state}`, policyVersion };
    const previous = get("SELECT policy_version FROM policy_candidates WHERE state='active_limited' ORDER BY updated_at DESC LIMIT 1");
    run("UPDATE policy_candidates SET state='replaced',updated_at=? WHERE state='active_limited' AND policy_version<>?", now, policyVersion);
    run("UPDATE policy_candidates SET state='active_limited',training_dataset_version=COALESCE(?,training_dataset_version),train_cutoff_at=?,previous_policy_version=?,updated_at=? WHERE policy_version=?", datasetVersion || null, now, previous?.policy_version || row.previous_policy_version || BASELINE_POLICY_VERSION, now, policyVersion);
    run(
      "INSERT OR IGNORE INTO policy_activations(id,policy_version,state,reason,previous_policy_version,activated_at,rollback_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
      hash({ policyVersion, datasetVersion: datasetVersion || null, reason }).slice(0, 32),
      policyVersion,
      "active_limited",
      reason,
      previous?.policy_version || row.previous_policy_version || BASELINE_POLICY_VERSION,
      now,
      null,
      now,
    );
    return { activated: true, policyVersion, reason };
  });
}

function evaluateGates({ policyVersion = SHADOW_POLICY_VERSION, datasetVersion, asOf = new Date().toISOString(), activate = true } = {}) {
  const dataset = datasetVersion
    ? get("SELECT * FROM feedback_datasets WHERE dataset_version=?", datasetVersion)
    : get("SELECT * FROM feedback_datasets ORDER BY created_at DESC LIMIT 1");
  const policy = get("SELECT * FROM policy_candidates WHERE policy_version=?", policyVersion);
  const counts = json(dataset?.counts_json, {});
  const coverage = json(dataset?.coverage_json, {});
  const metrics = datasetOutcomeMetrics(dataset, counts, coverage);
  const forwardSessions = tradingSessionsSince(policy?.created_at, dataset?.as_of || asOf);
  const gates = {
    ...DEFAULT_GATES,
    ...metrics,
    forwardSessions,
  };
  const passed =
    gates.forwardSessions >= gates.minForwardSessions &&
    metrics.resolvedSetups >= gates.minResolvedSetups &&
    metrics.prospectiveResolvedSetups >= gates.minProspectiveResolvedSetups &&
    metrics.priceCoveragePct >= gates.minPriceCoveragePct &&
    metrics.noFillPct <= gates.maxNoFillPct &&
    metrics.ambiguousPct <= gates.maxAmbiguousPct &&
    (!gates.requireReplayComplete || metrics.replayComplete) &&
    (!gates.requireValidationAdvantage || metrics.validationAdvantage);
  const decision = passed ? "eligible_for_limited_activation" : "shadow_insufficient_evidence";
  const failedReasons = [];
  if (gates.forwardSessions < gates.minForwardSessions) failedReasons.push("forward_sessions_insufficient");
  if (metrics.prospectiveResolvedSetups < gates.minProspectiveResolvedSetups) failedReasons.push("prospective_evidence_insufficient");
  if (metrics.resolvedSetups < gates.minResolvedSetups) failedReasons.push("resolved_setups_insufficient");
  if (metrics.priceCoveragePct < gates.minPriceCoveragePct) failedReasons.push("price_coverage_insufficient");
  if (metrics.noFillPct > gates.maxNoFillPct) failedReasons.push("no_fill_too_high");
  if (metrics.ambiguousPct > gates.maxAmbiguousPct) failedReasons.push("ambiguity_too_high");
  if (gates.requireReplayComplete && !metrics.replayComplete) failedReasons.push("replay_incomplete");
  if (gates.requireValidationAdvantage && !metrics.validationAdvantage) failedReasons.push("validation_advantage_missing");
  const reason = passed ? "prospective_window_replay_and_validation_gates_passed" : failedReasons.join(",") || "not_enough_forward_evidence_or_coverage";
  const createdAt = new Date().toISOString();
  run(
    "INSERT INTO policy_evaluations(id,policy_version,dataset_version,stage,metrics_json,gates_json,decision,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    hash({ policyVersion, datasetVersion: dataset?.dataset_version || null, createdAt }).slice(0, 32),
    policyVersion,
    dataset?.dataset_version || null,
    "gate_check",
    JSON.stringify({ ...metrics, counts, coverage }),
    JSON.stringify(gates),
    decision,
    reason,
    createdAt,
  );
  run(
    "UPDATE policy_candidates SET state=CASE WHEN state='shadow' AND ? THEN 'eligible_for_limited_activation' ELSE state END,evidence_json=?,updated_at=? WHERE policy_version=?",
    passed ? 1 : 0,
    JSON.stringify({ ...metrics, gates, decision, reason, evaluatedAt: createdAt, activationPending: passed && activate }),
    createdAt,
    policyVersion,
  );
  const training = passed
    ? trainLearnedPolicy({ datasetVersion: dataset?.dataset_version || null, now: createdAt, previousPolicyVersion: policyVersion })
    : { trained: false, reason: "gates_not_passed" };
  const activation = passed && activate && training.trained
    ? activatePolicy({ policyVersion: training.policyVersion, datasetVersion: dataset?.dataset_version || null, reason: `${reason}:learned_policy`, now: createdAt })
    : { activated: false, reason: passed ? "activation_disabled" : "gates_not_passed" };
  return { policyVersion, datasetVersion: dataset?.dataset_version || null, decision, reason, gates, metrics, training, activation };
}

function rollbackPolicy({ reason = "quality_gate_failed", now = new Date().toISOString() } = {}) {
  return store.transaction(() => {
    const active = get("SELECT * FROM policy_candidates WHERE state='active_limited' ORDER BY updated_at DESC LIMIT 1");
    if (!active) return { rolledBack: false, reason: "no_active_limited_policy" };
    run("UPDATE policy_candidates SET state='rolled_back',updated_at=? WHERE policy_version=?", now, active.policy_version);
    if (active.previous_policy_version && active.previous_policy_version !== BASELINE_POLICY_VERSION) {
      run("UPDATE policy_candidates SET state='active_limited',updated_at=? WHERE policy_version=? AND state IN ('replaced','rolled_back','eligible_for_limited_activation','shadow')", now, active.previous_policy_version);
    }
    run(
      "INSERT OR IGNORE INTO policy_activations(id,policy_version,state,reason,previous_policy_version,activated_at,rollback_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
      hash({ policyVersion: active.policy_version, reason, rollbackAt: now }).slice(0, 32),
      active.policy_version,
      "rolled_back",
      reason,
      active.previous_policy_version || BASELINE_POLICY_VERSION,
      null,
      now,
      now,
    );
    return { rolledBack: true, policyVersion: active.policy_version, reason };
  });
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
      : "Feedback is measuring and comparing in shadow for a 7-trading-session window; live ranking changes only after the gates pass.",
  };
}

module.exports = {
  BASELINE_POLICY_VERSION,
  SHADOW_POLICY_VERSION,
  FEATURE_SCHEMA_VERSION,
  GATE_VERSION,
  LEARNER_VERSION,
  candidateFeatureSnapshot,
  activePolicy,
  ensureShadowPolicy,
  tradingSessionsSince,
  trainLearnedPolicy,
  scoreCandidate,
  maybeApplyPolicyToList,
  recordSelectionDecision,
  buildDataset,
  evaluateGates,
  activatePolicy,
  rollbackPolicy,
  status,
};
