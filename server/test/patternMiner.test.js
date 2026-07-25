const test = require('node:test');
const assert = require('node:assert/strict');
const { FEATURE_NAMES } = require('../src/services/research/asOfFeatures');
const { computeBinBoundaries, discoverPatterns, evaluatePattern, passesHoldoutGate } = require('../src/services/research/patternMiner');

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseFeatures(overrides = {}) {
  const features = {};
  for (const name of FEATURE_NAMES) {
    features[name] = 0.5;
  }
  return { ...features, ...overrides };
}

// ---- Test 8.4: a genuinely planted pattern must be found ----
test('discoverPatterns finds a planted feature->event relationship with meaningful lift', () => {
  const random = mulberry32(1);
  const rows = [];

  for (let i = 0; i < 3000; i += 1) {
    const volumeRatio1d = random() * 5; // uniform [0, 5) -> 75th percentile ~= 3.75
    const isTopQuartile = volumeRatio1d >= 3.75;
    const isEvent = isTopQuartile ? random() < 0.5 : random() < 0.0333; // -> overall baseRate ~0.15

    rows.push({
      symbol: `SYM${i % 80}`,
      date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
      features: baseFeatures({ volumeRatio1d }),
      isEvent
    });
  }

  const result = discoverPatterns(rows);
  const found = result.patterns.find((p) => p.depth === 1 && p.conditions[0].feature === 'volumeRatio1d' && p.conditions[0].bin === 3);

  assert.ok(found, 'expected a surviving pattern for volumeRatio1d top quartile');
  assert.ok(found.lift > 2, `expected strong lift, got ${found.lift}`);
  assert.ok(found.wilsonLB > result.baseRate);
});

// ---- Test 8.5: pure noise must produce zero survivors AFTER the holdout gate ----
// Note what this test does NOT claim: in-sample discovery alone on ~2000 candidate conditions is
// expected to throw off a handful of spurious survivors by pure multiple-comparisons chance (see
// docs/SPEC_ANOMALY_MINING.md section 0.3) - that is exactly why the holdout re-test exists. The
// spec's actual requirement (section 8.5) is that zero patterns survive the FULL pipeline: discover
// on a random in-sample split, then re-evaluate on an independently-generated holdout split.
test('noise dataset: patterns discovered in-sample find zero survivors on an independent holdout split', () => {
  const random = mulberry32(7);

  function buildNoiseRows(count, offset) {
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      const features = {};
      for (const name of FEATURE_NAMES) {
        features[name] = random() * 10;
      }
      rows.push({
        symbol: `SYM${(i + offset) % 100}`,
        date: `2024-${String(((i + offset) % 12) + 1).padStart(2, '0')}-${String(((i + offset) % 28) + 1).padStart(2, '0')}`,
        features,
        isEvent: random() < 0.07
      });
    }
    return rows;
  }

  // Sized to approximate the false-discovery math of the real pipeline (section 2.2: ~112k
  // in-sample / ~56k holdout stock-days): with too few rows, a handful of the ~2000 depth-2
  // candidates clear the holdout bar by pure chance even though nothing is real. At this scale the
  // Wilson-interval margin around a random deviation shrinks enough that this stops happening -
  // which is itself the point being tested (the gate's reliability scales with sample size).
  const inSampleRows = buildNoiseRows(20000, 0);
  const holdoutRows = buildNoiseRows(10000, 20000); // independently generated, not a slice of the same draws

  const discovery = discoverPatterns(inSampleRows);
  const holdoutBaseRate = holdoutRows.filter((r) => r.isEvent).length / holdoutRows.length;

  const survivors = discovery.patterns.filter((pattern) => {
    const holdoutEval = evaluatePattern(holdoutRows, pattern, discovery.boundaries, holdoutBaseRate);
    return passesHoldoutGate(holdoutEval, holdoutBaseRate);
  });

  assert.equal(
    survivors.length,
    0,
    `expected zero patterns to survive the holdout gate on pure noise, got: ${JSON.stringify(survivors.map((p) => p.label))}`
  );
});

// ---- Test 8.6: bin boundaries are computed from in-sample only, reused unchanged for holdout ----
test('evaluatePattern classifies a holdout row using the in-sample boundaries, not boundaries recomputed from holdout data', () => {
  const inSampleRows = [];
  for (let i = 0; i < 1000; i += 1) {
    // uniform 0..10 -> quartile cuts approximately [2.5, 5, 7.5]
    inSampleRows.push({ symbol: `S${i}`, date: '2024-01-01', features: baseFeatures({ volumeRatio1d: (i / 1000) * 10 }), isEvent: false });
  }

  const boundaries = computeBinBoundaries(inSampleRows);
  const cuts = boundaries.volumeRatio1d.cuts;
  assert.ok(Math.abs(cuts[0] - 2.5) < 0.2 && Math.abs(cuts[1] - 5) < 0.2 && Math.abs(cuts[2] - 7.5) < 0.2);

  // A single holdout row with value 6: under the in-sample boundaries that's bin 2 (>=5, <7.5).
  // If boundaries were wrongly recomputed from the holdout set alone (a single value), quantile of
  // one point equals that point itself, and 6 < 6 is false for every cut -> it would land in bin 3.
  const holdoutRows = [{ symbol: 'HOLD', date: '2025-01-01', features: baseFeatures({ volumeRatio1d: 6 }), isEvent: false }];
  const pattern = { conditions: [{ feature: 'volumeRatio1d', bin: 2, label: 'x' }] };

  const evalResult = evaluatePattern(holdoutRows, pattern, boundaries, 0.1);
  assert.equal(evalResult.n, 1, 'holdout row should match bin 2 under the in-sample boundaries');

  const wrongBinPattern = { conditions: [{ feature: 'volumeRatio1d', bin: 3, label: 'x' }] };
  const wrongEvalResult = evaluatePattern(holdoutRows, wrongBinPattern, boundaries, 0.1);
  assert.equal(wrongEvalResult.n, 0, 'holdout row must NOT match bin 3, which is what a recomputed boundary would have produced');
});

// ---- Test 8.8: symbol/date concentration and depth-2 redundancy filters ----
test('discoverPatterns rejects a pattern whose hits all come from one symbol, but keeps an equally strong pattern spread across many symbols, and rejects a redundant depth-2 copy', () => {
  const N = 1000;

  // volumeRatio1d: sorted 0..3.996 by construction, so its top quartile is exactly i in [750,1000)
  // - a clean, contiguous "concentrated" target group.
  const volumeRatio1d = Array.from({ length: N }, (_, i) => i / 250);

  // adrContraction: independent RNG draws (NOT a function of i's order), so its own top-quartile
  // group is scattered across indices - uncorrelated with volumeRatio1d's contiguous blocks. This
  // avoids the coupling bug where two features built from the same index ranges accidentally share
  // membership even though they're meant to be independent signals.
  const random = mulberry32(3);
  const adrContraction = Array.from({ length: N }, () => random() * 4);

  const sortedByAdr = adrContraction.map((value, i) => [value, i]).sort((a, b) => a[0] - b[0]);
  const top25pctIndices = sortedByAdr.slice(Math.floor(N * 0.75)).map(([, i]) => i);
  // Keep control-group indices away from i>=750 (reserved for the volumeRatio1d concentrated case)
  // so the two scenarios can't bleed into each other.
  const controlCandidates = top25pctIndices.filter((i) => i < 700);
  const controlIndices = controlCandidates.slice(0, 60);

  const rows = [];
  for (let i = 0; i < N; i += 1) {
    let isEvent = false;
    let symbol = `SYM${i % 50}`;
    if (i >= 750 && i < 810) {
      // Concentrated: all 60 hits in the volumeRatio1d top-quartile group come from one symbol.
      isEvent = true;
      symbol = 'HOG';
    }
    rows.push({
      symbol,
      date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
      features: baseFeatures({ volumeRatio1d: volumeRatio1d[i], adrContraction: adrContraction[i], priceVsMa50: adrContraction[i] }),
      isEvent
    });
  }

  // Control: hits inside the adrContraction top-quartile group, spread across 60 distinct symbols.
  controlIndices.forEach((i, k) => {
    rows[i].isEvent = true;
    rows[i].symbol = `CTRL${k}`;
  });

  // 20 more scattered background hits so the overall base rate is realistic, avoiding every index
  // already used above.
  const used = new Set([...controlIndices, ...Array.from({ length: 60 }, (_, k) => 750 + k)]);
  let backgroundCount = 0;
  for (let i = 0; i < N && backgroundCount < 20; i += 1) {
    if (!used.has(i) && !(i >= 750 && i < 810)) {
      rows[i].isEvent = true;
      backgroundCount += 1;
    }
  }

  const result = discoverPatterns(rows);

  const concentratedSurvived = result.patterns.some((p) => p.conditions.some((c) => c.feature === 'volumeRatio1d'));
  const controlSurvived = result.patterns.some((p) => p.depth === 1 && p.conditions[0].feature === 'adrContraction');
  const redundantPairSurvived = result.patterns.some(
    (p) => p.depth === 2 && p.conditions.some((c) => c.feature === 'adrContraction') && p.conditions.some((c) => c.feature === 'priceVsMa50')
  );

  assert.equal(concentratedSurvived, false, 'a pattern concentrated in a single symbol must be rejected');
  assert.equal(controlSurvived, true, 'an equally strong pattern spread across many symbols must survive');
  assert.equal(redundantPairSurvived, false, 'a depth-2 pair that adds no information over its stronger parent (an identical copy) must be rejected as redundant');
});
