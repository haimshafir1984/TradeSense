// Pure statistics helpers for anomaly mining (docs/SPEC_ANOMALY_MINING.md section 6.3).
// No dependency on any other module in this repo - keep these testable in isolation.

// Wilson score interval lower bound (95% CI by default). This is the ranking metric for patterns
// (section 6.3) precisely because it punishes small samples: 3/4 hits scores far below 200/1500
// hits even though the raw proportion (0.75) is higher, which is what stops small-sample flukes
// from dominating the ranked list.
function wilsonLowerBound(hits, n, z = 1.96) {
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }

  const p = hits / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  return (center - margin) / denominator;
}

// How many times more likely an event is under this pattern than in the general population.
// Guarded against a zero/invalid base rate rather than returning Infinity/NaN into a report.
function lift(p, baseRate) {
  if (!Number.isFinite(baseRate) || baseRate <= 0) {
    return 0;
  }
  return p / baseRate;
}

module.exports = {
  wilsonLowerBound,
  lift
};
