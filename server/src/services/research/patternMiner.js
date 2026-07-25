// Pattern discovery for anomaly mining (docs/SPEC_ANOMALY_MINING.md sections 6, 4).
//
// Input rows look like { symbol, date, features: {...16 features...}, isEvent: boolean } - already
// filtered to eligible+labeled rows (eventLabeler.js) for ONE split (in-sample or holdout). This
// module never decides the split itself; that's anomalyResearchService.js's job (section 6.1).
//
// The two things that make this module trustworthy rather than an overfitting machine (section
// 0.3): (1) a closed, fixed feature list (imported from asOfFeatures.js, never invented here), and
// (2) mandatory filters in discoverPatterns (section 6.4) that reject small samples, weak lift, and
// results concentrated in one symbol/day/parent-condition. server/test/patternMiner.test.js proves
// this with a pure-noise dataset that must produce zero surviving patterns (spec test 8.5).
const { FEATURE_NAMES } = require('./asOfFeatures');
const { wilsonLowerBound, lift } = require('./stats');

const DEFAULTS = {
  minSupport: 200,
  minLift: 1.5,
  maxSymbolConcentration: 0.3,
  maxDateConcentration: 0.3,
  redundancyMinImprovement: 1.2, // a depth-2 pattern must beat both parents' wilsonLB by >=20%
  maxPatterns: 20
};

// gapCount10d is a small integer count, not a continuous quantity - fixed bins (0 / 1 / 2 / 3+)
// are more meaningful than quartiles computed on a near-discrete distribution (section 4).
const FIXED_BIN_FEATURES = new Set(['gapCount10d']);

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) {
    return NaN;
  }
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedAsc[base + 1] !== undefined) {
    return sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]);
  }
  return sortedAsc[base];
}

// Computes bin boundaries from `rows` only (section 6.2: "גבולות הסלים מחושבים על ה-in-sample
// בלבד"). Callers must reuse the returned object for the holdout split unchanged - see
// binValue below, which takes boundaries as a plain parameter rather than recomputing them.
function computeBinBoundaries(rows, featureNames = FEATURE_NAMES) {
  const boundaries = {};

  for (const feature of featureNames) {
    if (FIXED_BIN_FEATURES.has(feature)) {
      boundaries[feature] = { type: 'fixed' };
      continue;
    }

    const values = rows.map((row) => row.features[feature]).filter(Number.isFinite).sort((a, b) => a - b);
    boundaries[feature] = {
      type: 'quartile',
      cuts: [quantile(values, 0.25), quantile(values, 0.5), quantile(values, 0.75)]
    };
  }

  return boundaries;
}

function binValue(feature, value, featureBoundaries) {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (featureBoundaries.type === 'fixed') {
    if (value <= 0) return 0;
    if (value === 1) return 1;
    if (value === 2) return 2;
    return 3;
  }

  const [q1, q2, q3] = featureBoundaries.cuts;
  if (value < q1) return 0;
  if (value < q2) return 1;
  if (value < q3) return 2;
  return 3;
}

function conditionId(feature, bin) {
  return `${feature}#${bin}`;
}

// One condition id per feature (skips features whose value was NaN for this row - a NaN feature
// never "occurs" in any bin, it simply doesn't contribute a condition for that row).
function triggeredConditions(row, boundaries, featureNames) {
  const ids = [];
  for (const feature of featureNames) {
    const bin = binValue(feature, row.features[feature], boundaries[feature]);
    if (bin !== null) {
      ids.push(conditionId(feature, bin));
    }
  }
  return ids;
}

function newCounter() {
  return { n: 0, hits: 0 };
}

function computeStats(counter, baseRate) {
  const p = counter.n > 0 ? counter.hits / counter.n : 0;
  return {
    n: counter.n,
    hits: counter.hits,
    p,
    lift: lift(p, baseRate),
    wilsonLB: wilsonLowerBound(counter.hits, counter.n)
  };
}

function parseConditionId(id) {
  const [feature, binStr] = id.split('#');
  return { feature, bin: Number(binStr) };
}

function conditionLabel(feature, bin, boundaries) {
  const featureBoundaries = boundaries[feature];
  if (featureBoundaries.type === 'fixed') {
    return bin === 3 ? `${feature} >= 3` : `${feature} = ${bin}`;
  }
  const [q1, q2, q3] = featureBoundaries.cuts;
  const edges = [-Infinity, q1, q2, q3, Infinity];
  const lo = edges[bin];
  const hi = edges[bin + 1];
  const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : x > 0 ? '+inf' : '-inf');
  return `${feature} in [${fmt(lo)}, ${fmt(hi)})`;
}

function buildPattern(conditionIds, boundaries, statsResult) {
  const conditions = conditionIds.map((id) => {
    const { feature, bin } = parseConditionId(id);
    return { feature, bin, label: conditionLabel(feature, bin, boundaries) };
  });
  return {
    id: conditionIds.join('&'),
    depth: conditionIds.length,
    conditions,
    label: conditions.map((c) => c.label).join(' AND '),
    ...statsResult
  };
}

// Concentration + (for depth 2) redundancy checks require walking rows again, but only for the
// small shortlist that already passed support/lift/wilsonLB - see discoverPatterns for why this is
// split into two passes instead of tracking symbol/date breakdowns for all ~1900 candidates.
function computeConcentration(rows, boundaries, featureNames, conditionIds) {
  const hitsBySymbol = new Map();
  const hitsByDate = new Map();
  let hits = 0;

  for (const row of rows) {
    const triggered = new Set(triggeredConditions(row, boundaries, featureNames));
    const matches = conditionIds.every((id) => triggered.has(id));
    if (matches && row.isEvent) {
      hits += 1;
      hitsBySymbol.set(row.symbol, (hitsBySymbol.get(row.symbol) || 0) + 1);
      hitsByDate.set(row.date, (hitsByDate.get(row.date) || 0) + 1);
    }
  }

  const maxSymbolShare = hits > 0 ? Math.max(...hitsBySymbol.values()) / hits : 0;
  const maxDateShare = hits > 0 ? Math.max(...hitsByDate.values()) / hits : 0;
  return { maxSymbolShare, maxDateShare, uniqueSymbols: hitsBySymbol.size, uniqueDates: hitsByDate.size };
}

function passesBasicGate(statsResult, baseRate, options) {
  if (statsResult.n < options.minSupport) return false;
  if (statsResult.wilsonLB <= baseRate) return false;
  if (statsResult.lift < options.minLift) return false;
  return true;
}

// Discovers depth-1 and depth-2 patterns from `rows` (one split - see module header). Returns
// { boundaries, baseRate, patterns } where boundaries MUST be reused verbatim (via evaluatePattern)
// when checking these same patterns against a holdout split (section 6.1/6.2).
function discoverPatterns(rows, rawOptions = {}) {
  const options = { ...DEFAULTS, ...rawOptions };
  const featureNames = rawOptions.featureNames || FEATURE_NAMES;
  const boundaries = computeBinBoundaries(rows, featureNames);

  const totalRows = rows.length;
  const totalHits = rows.filter((row) => row.isEvent).length;
  const baseRate = totalRows > 0 ? totalHits / totalRows : 0;

  // Pass A: cheap single sweep building depth-1 and depth-2 (co-occurrence) counters.
  const depth1Counters = new Map();
  const depth2Counters = new Map();

  for (const row of rows) {
    const triggered = triggeredConditions(row, boundaries, featureNames);

    for (const id of triggered) {
      const counter = depth1Counters.get(id) || newCounter();
      counter.n += 1;
      if (row.isEvent) counter.hits += 1;
      depth1Counters.set(id, counter);
    }

    for (let i = 0; i < triggered.length; i += 1) {
      for (let j = i + 1; j < triggered.length; j += 1) {
        const pairId = [triggered[i], triggered[j]].sort().join('&');
        const counter = depth2Counters.get(pairId) || newCounter();
        counter.n += 1;
        if (row.isEvent) counter.hits += 1;
        depth2Counters.set(pairId, counter);
      }
    }
  }

  // Full depth-1 stats table (not just survivors) - depth-2's redundancy filter needs to look up
  // ANY parent's wilsonLB, including parents that didn't themselves pass the support/lift gate.
  const depth1Stats = new Map();
  for (const [id, counter] of depth1Counters) {
    depth1Stats.set(id, computeStats(counter, baseRate));
  }

  // Pass B: apply support/wilsonLB/lift gate to shrink to a shortlist before the expensive
  // per-candidate concentration re-scan (section 5.3 performance note).
  const depth1Shortlist = [];
  for (const [id, statsResult] of depth1Stats) {
    if (passesBasicGate(statsResult, baseRate, options)) {
      depth1Shortlist.push({ conditionIds: [id], statsResult });
    }
  }

  const depth2Shortlist = [];
  for (const [pairId, counter] of depth2Counters) {
    const statsResult = computeStats(counter, baseRate);
    if (!passesBasicGate(statsResult, baseRate, options)) {
      continue;
    }

    const [idA, idB] = pairId.split('&');
    const parentA = depth1Stats.get(idA) || { wilsonLB: 0 };
    const parentB = depth1Stats.get(idB) || { wilsonLB: 0 };
    const bestParentWilsonLB = Math.max(parentA.wilsonLB, parentB.wilsonLB);

    // Redundancy filter (section 6.4.6): the pair must beat its stronger parent by a real margin,
    // otherwise the second condition added nothing but a smaller sample.
    if (statsResult.wilsonLB < bestParentWilsonLB * options.redundancyMinImprovement) {
      continue;
    }

    depth2Shortlist.push({ conditionIds: pairId.split('&'), statsResult });
  }

  // Pass C: concentration filter, only for the (small) shortlist.
  const survivors = [];
  for (const candidate of [...depth1Shortlist, ...depth2Shortlist]) {
    const concentration = computeConcentration(rows, boundaries, featureNames, candidate.conditionIds);
    if (concentration.maxSymbolShare > options.maxSymbolConcentration) continue;
    if (concentration.maxDateShare > options.maxDateConcentration) continue;

    survivors.push(
      buildPattern(candidate.conditionIds, boundaries, {
        ...candidate.statsResult,
        uniqueSymbols: concentration.uniqueSymbols,
        uniqueDates: concentration.uniqueDates
      })
    );
  }

  survivors.sort((a, b) => b.wilsonLB - a.wilsonLB);

  return {
    boundaries,
    baseRate,
    totalRows,
    totalHits,
    patterns: survivors.slice(0, options.maxPatterns)
  };
}

// Evaluates an already-discovered pattern's condition set against an arbitrary row set (used for
// the holdout split - section 6.5 - with the SAME boundaries the pattern was discovered under).
function evaluatePattern(rows, pattern, boundaries, baseRate) {
  const featureNames = pattern.conditions.map((c) => c.feature);
  const conditionIds = pattern.conditions.map((c) => conditionId(c.feature, c.bin));

  const counter = newCounter();
  for (const row of rows) {
    const triggered = new Set(triggeredConditions(row, boundaries, featureNames));
    if (conditionIds.every((id) => triggered.has(id))) {
      counter.n += 1;
      if (row.isEvent) counter.hits += 1;
    }
  }

  const statsResult = computeStats(counter, baseRate);
  const concentration = computeConcentration(rows, boundaries, featureNames, conditionIds);

  return { ...statsResult, uniqueSymbols: concentration.uniqueSymbols, uniqueDates: concentration.uniqueDates };
}

// Holdout gate (section 6.5): a pattern "survives" only if all three hold on the holdout split.
function passesHoldoutGate(holdoutEval, baseRateHoldout, rawOptions = {}) {
  const options = { ...DEFAULTS, ...rawOptions };
  if (holdoutEval.n < 30) return false;
  if (holdoutEval.lift < options.minLift) return false;
  if (holdoutEval.wilsonLB <= baseRateHoldout) return false;
  return true;
}

module.exports = {
  DEFAULTS,
  computeBinBoundaries,
  binValue,
  discoverPatterns,
  evaluatePattern,
  passesHoldoutGate
};
