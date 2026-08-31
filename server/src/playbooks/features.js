// Shared as-of feature computation for the whole pipeline (docs/SPEC_V2_ARCHITECTURE.md §4:
// "playbooks/features.js - חישוב פיצ'רים as-of, משותף"). Every layer downstream - the liquidity
// gate, the relative-volume selector, the regime gate, and every playbook's own eligibility check
// - reads its inputs from here instead of recomputing indicators inline, so a single definition of
// "ATR14" or "MA200" can't drift between two call sites.
//
// Anti-lookahead by construction (§1 rule 3): every function here takes an explicit bars array and
// only ever reads bars[0..i] for the value "as of" bar i - nothing reaches past the array it was
// given. Bars are always oldest-first (the alpacaService contract).
const { average, computeRsi, computeTrailingReturnPct } = require('../services/mathUtils');

// Wilder's Average True Range. Returns null (not 0, not a guess) when there isn't enough history -
// a fabricated ATR would corrupt every stop-distance calculation downstream (risk/exitEngine.js).
function computeAtr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) {
    return null;
  }

  const trueRanges = [];
  for (let index = 1; index < bars.length; index += 1) {
    const high = Number(bars[index]?.h);
    const low = Number(bars[index]?.l);
    const prevClose = Number(bars[index - 1]?.c);

    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) {
      continue;
    }

    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  if (trueRanges.length < period) {
    return null;
  }

  // Wilder smoothing: seed with a simple average of the first `period` true ranges, then smooth
  // the rest - same shape as mathUtils#computeRsi's gain/loss smoothing.
  let atr = average(trueRanges.slice(0, period));
  for (const tr of trueRanges.slice(period)) {
    atr = (atr * (period - 1) + tr) / period;
  }

  return atr;
}

function simpleMovingAverage(bars, period) {
  if (!Array.isArray(bars) || bars.length < period) {
    return null;
  }

  const closes = bars.slice(-period).map((bar) => Number(bar?.c));
  if (closes.some((close) => !Number.isFinite(close))) {
    return null;
  }

  return average(closes);
}

// Slope of MA50 over the trailing 5 bars, as a fraction of its own value (matches the old
// strategies.js#ma50_slope definition) - used by playbooks that check trend direction, not just
// trend level.
function computeMa50Slope(bars) {
  const currentMa50 = simpleMovingAverage(bars, 50);
  if (currentMa50 === null || bars.length < 55) {
    return null;
  }

  const previousMa50 = simpleMovingAverage(bars.slice(0, -5), 50);
  if (previousMa50 === null || previousMa50 === 0) {
    return null;
  }

  return (currentMa50 - previousMa50) / previousMa50;
}

function computeAverageVolume(bars, period) {
  if (!Array.isArray(bars) || bars.length < period) {
    return null;
  }

  const volumes = bars.slice(-period).map((bar) => Number(bar?.v));
  if (volumes.some((volume) => !Number.isFinite(volume))) {
    return null;
  }

  return average(volumes);
}

function computeHighLow(bars, period) {
  const window = period ? bars.slice(-period) : bars;
  const highs = window.map((bar) => Number(bar?.h)).filter(Number.isFinite);
  const lows = window.map((bar) => Number(bar?.l)).filter(Number.isFinite);

  return {
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null
  };
}

// The single feature-computation entry point every pipeline layer and playbook shares. Takes
// daily bars (oldest-first) for one symbol and returns everything downstream might need, with
// null for anything that couldn't be measured from the given history - never a fabricated
// default (§1 rule 1).
function computeFeaturesFromBars(bars) {
  const safeBars = Array.isArray(bars) ? bars : [];
  const last = safeBars[safeBars.length - 1];
  const previous = safeBars[safeBars.length - 2];
  const price = Number(last?.c);
  const previousClose = Number(previous?.c);
  const dailyChangePct =
    Number.isFinite(price) && Number.isFinite(previousClose) && previousClose > 0
      ? ((price - previousClose) / previousClose) * 100
      : null;
  const closes = safeBars.map((bar) => Number(bar?.c));

  const range52w = computeHighLow(safeBars, 252);
  const range20d = computeHighLow(safeBars, 20);

  return {
    barCount: safeBars.length,
    price: Number.isFinite(price) ? price : null,
    volume: Number.isFinite(Number(last?.v)) ? Number(last.v) : null,
    dailyChangePct,
    atr14: computeAtr(safeBars, 14),
    ma20: simpleMovingAverage(safeBars, 20),
    ma50: simpleMovingAverage(safeBars, 50),
    ma200: simpleMovingAverage(safeBars, 200),
    ma50Slope: computeMa50Slope(safeBars),
    rsi14: computeRsi(closes, 14),
    return5d: computeTrailingReturnPct(closes, 5),
    return20d: computeTrailingReturnPct(closes, 20),
    avgVolume14d: computeAverageVolume(safeBars, 14),
    avgVolume20d: computeAverageVolume(safeBars, 20),
    high52w: range52w.high,
    low52w: range52w.low,
    high20d: range20d.high,
    low20d: range20d.low
  };
}

// Realized volatility: standard deviation of daily returns over the trailing `period` bars,
// expressed as a fraction (0.03 = 3% typical daily move) - not annualized. Used by
// pipeline/regimeGate.js. Returns null when there isn't enough history.
function computeRealizedVolatility(bars, period = 20) {
  if (!Array.isArray(bars) || bars.length < period + 1) {
    return null;
  }

  const closes = bars.slice(-(period + 1)).map((bar) => Number(bar?.c));
  if (closes.some((close) => !Number.isFinite(close) || close <= 0)) {
    return null;
  }

  const returns = closes.slice(1).map((value, index) => (value - closes[index]) / closes[index]);
  const meanReturn = average(returns);
  const variance = average(returns.map((value) => (value - meanReturn) ** 2));

  return Math.sqrt(variance);
}

module.exports = {
  computeFeaturesFromBars,
  computeAtr,
  computeRealizedVolatility,
  simpleMovingAverage
};
