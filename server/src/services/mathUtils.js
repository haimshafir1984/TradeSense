function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function average(values = []) {
  const filtered = values.filter((value) => Number.isFinite(value));

  if (!filtered.length) {
    return 0;
  }

  return filtered.reduce((total, value) => total + value, 0) / filtered.length;
}

// Linear-maps value into [0,1] over [min,max], clamped at both ends. Used by playbooks (§5.3) to
// turn a raw measurement (e.g. an earnings surprise of 12%) into a 0-1 conviction factor - never a
// probability, just a relative-strength scale for internal ranking.
function normalize(value, min, max) {
  if (!Number.isFinite(value) || max <= min) {
    return 0;
  }

  return clamp((value - min) / (max - min));
}

function median(values = []) {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);

  if (!filtered.length) {
    return null;
  }

  const mid = Math.floor(filtered.length / 2);
  return filtered.length % 2 === 0 ? (filtered[mid - 1] + filtered[mid]) / 2 : filtered[mid];
}

// Kept for services/research/asOfFeatures.js (docs/SPEC_V2_ARCHITECTURE.md §2: research/** stays
// untouched). The v2 spec (§3.5) calls for removing this, but doing so would break that kept
// module - research/** takes priority since it's an explicit "stays as-is" per §2.
function scoreConsolidation(closes, high52, low52) {
  if (!closes.length) {
    return 0.5;
  }

  const localHigh = Math.max(...closes);
  const localLow = Math.min(...closes);
  const range = localHigh && localLow ? (localHigh - localLow) / localHigh : 0.1;
  const yearlyRange = high52 && low52 ? (high52 - low52) / high52 : 0.25;

  return clamp(1 - range / Math.max(yearlyRange, 0.08));
}

// Wilder's RSI. Takes closes OLDEST-FIRST - the two stock builders store their series in opposite
// orders (barsStockBuilder oldest-first, marketDataService newest-first), so the ordering is part
// of this contract rather than something each caller guesses at.
//
// Returns null, not 50, when there isn't enough history: a fabricated "neutral" reading would let
// a stock score on a momentum/reversion factor that was never actually measured.
function computeRsi(closesOldestFirst = [], period = 14) {
  const closes = closesOldestFirst.filter((value) => Number.isFinite(value) && value > 0);

  if (closes.length < period + 1) {
    return null;
  }

  const changes = closes.slice(1).map((value, index) => value - closes[index]);

  // Seed with a simple average of the first `period` changes, then smooth the rest (Wilder).
  let avgGain = average(changes.slice(0, period).map((change) => (change > 0 ? change : 0)));
  let avgLoss = average(changes.slice(0, period).map((change) => (change < 0 ? -change : 0)));

  for (const change of changes.slice(period)) {
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }

  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Percent change over the last `lookback` bars, from closes OLDEST-FIRST (same contract as
// computeRsi). Null when the series is too short, for the same reason.
function computeTrailingReturnPct(closesOldestFirst = [], lookback) {
  const closes = closesOldestFirst.filter((value) => Number.isFinite(value) && value > 0);

  if (closes.length <= lookback) {
    return null;
  }

  const latest = closes[closes.length - 1];
  const earlier = closes[closes.length - 1 - lookback];

  return earlier > 0 ? ((latest - earlier) / earlier) * 100 : null;
}

module.exports = {
  clamp,
  round,
  average,
  median,
  normalize,
  scoreConsolidation,
  computeRsi,
  computeTrailingReturnPct
};
