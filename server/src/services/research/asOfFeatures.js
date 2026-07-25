// Point-in-time feature computation for anomaly mining (docs/SPEC_ANOMALY_MINING.md section 4).
//
// THE SINGLE HARD RULE OF THIS FILE: computeFeaturesAt(bars, t) must never read bars[i] for i > t.
// Any leak of future data into a feature makes every downstream result look spuriously good while
// being worthless (see spec section 1.2). server/test/asOfFeatures.test.js verifies this by
// comparing computeFeaturesAt(fullBars, t) against computeFeaturesAt(fullBars.slice(0, t + 1), t)
// for every t - they must be byte-for-byte identical.
//
// `bars` is an array of { t: ISO date string, o, h, l, c, v }, oldest-to-newest (same shape as
// alpacaService.getDailyBars / historicalBarsStore output).
const { average, scoreConsolidation } = require('../mathUtils');

const FEATURE_NAMES = [
  'volumeRatio1d',
  'volumeRatio3d',
  'volumeTrend5d',
  'adrPct20d',
  'adrContraction',
  'consolidationScore',
  'highProximity60d',
  'distFromLow60d',
  'return5d',
  'return20d',
  'ma50Slope',
  'priceVsMa50',
  'priceVsMa200',
  'rangePosition20d',
  'gapCount10d',
  'dailyChange'
];

function numAt(bars, index, field) {
  const value = bars[index]?.[field];
  return Number.isFinite(value) ? value : Number(value);
}

// Inclusive index window [end-length+1, end], clamped to 0 - never looks past `end`.
function windowIndices(end, length) {
  const start = Math.max(0, end - length + 1);
  const indices = [];
  for (let i = start; i <= end; i += 1) {
    indices.push(i);
  }
  return indices;
}

function seriesAt(bars, indices, field) {
  return indices.map((i) => numAt(bars, i, field)).filter(Number.isFinite);
}

function averageDailyRangePct(bars, indices) {
  const values = indices
    .map((i) => {
      const h = numAt(bars, i, 'h');
      const l = numAt(bars, i, 'l');
      return Number.isFinite(h) && Number.isFinite(l) && l > 0 ? ((h - l) / l) * 100 : NaN;
    })
    .filter(Number.isFinite);
  return values.length ? average(values) : NaN;
}

function movingAverageClose(bars, end, length) {
  const closes = seriesAt(bars, windowIndices(end, length), 'c');
  return closes.length ? average(closes) : NaN;
}

// Computes all 16 features "as of" the close of bars[t], using only bars[0..t]. Never reads
// bars[t+1] or beyond - see the anti-lookahead contract at the top of this file.
function computeFeaturesAt(bars, t) {
  const close = numAt(bars, t, 'c');
  const prevClose = t >= 1 ? numAt(bars, t - 1, 'c') : NaN;

  const window20 = windowIndices(t, 20);
  const window5 = windowIndices(t, 5);
  const window3 = windowIndices(t, 3);
  const window60 = windowIndices(t, 60);
  const window10 = windowIndices(t, 10);

  // "prior 15 days" window for volumeTrend5d: t-19..t-5 inclusive (15 days), i.e. window20 minus
  // the most recent 5 days.
  const priorVolumeWindow = windowIndices(t - 5, 15);

  const volumeToday = numAt(bars, t, 'v');
  const avgVolume20 = average(seriesAt(bars, window20, 'v'));
  const avgVolume3 = average(seriesAt(bars, window3, 'v'));
  const avgVolume5 = average(seriesAt(bars, window5, 'v'));
  const avgVolumePrior15 = average(seriesAt(bars, priorVolumeWindow, 'v'));

  const volumeRatio1d = avgVolume20 > 0 ? volumeToday / avgVolume20 : NaN;
  const volumeRatio3d = avgVolume20 > 0 ? avgVolume3 / avgVolume20 : NaN;
  const volumeTrend5d = avgVolumePrior15 > 0 ? avgVolume5 / avgVolumePrior15 : NaN;

  const adrPct20d = averageDailyRangePct(bars, window20);
  const adrPct5d = averageDailyRangePct(bars, window5);
  const adrContraction = adrPct20d > 0 ? adrPct5d / adrPct20d : NaN;

  const closes20 = seriesAt(bars, window20, 'c');
  const highs60 = seriesAt(bars, window60, 'h');
  const lows60 = seriesAt(bars, window60, 'l');
  const high60 = highs60.length ? Math.max(...highs60) : NaN;
  const low60 = lows60.length ? Math.min(...lows60) : NaN;
  const consolidationScore = closes20.length ? scoreConsolidation(closes20, high60, low60) : NaN;

  const highProximity60d = Number.isFinite(high60) && high60 > 0 ? close / high60 : NaN;
  const distFromLow60d = Number.isFinite(low60) && low60 > 0 ? close / low60 - 1 : NaN;

  const close5Ago = t >= 5 ? numAt(bars, t - 5, 'c') : NaN;
  const close20Ago = t >= 20 ? numAt(bars, t - 20, 'c') : NaN;
  const return5d = Number.isFinite(close5Ago) && close5Ago > 0 ? close / close5Ago - 1 : NaN;
  const return20d = Number.isFinite(close20Ago) && close20Ago > 0 ? close / close20Ago - 1 : NaN;

  const ma50 = movingAverageClose(bars, t, 50);
  const ma50Prior = t >= 5 ? movingAverageClose(bars, t - 5, 50) : NaN;
  const ma50Slope = Number.isFinite(ma50Prior) && ma50Prior > 0 ? (ma50 - ma50Prior) / ma50Prior : NaN;
  const priceVsMa50 = Number.isFinite(ma50) && ma50 > 0 ? close / ma50 - 1 : NaN;

  const ma200 = movingAverageClose(bars, t, 200);
  const priceVsMa200 = Number.isFinite(ma200) && ma200 > 0 ? close / ma200 - 1 : NaN;

  const closes20ForRange = closes20;
  const highs20 = seriesAt(bars, window20, 'h');
  const lows20 = seriesAt(bars, window20, 'l');
  const maxHigh20 = highs20.length ? Math.max(...highs20) : NaN;
  const minLow20 = lows20.length ? Math.min(...lows20) : NaN;
  const range20 = Number.isFinite(maxHigh20) && Number.isFinite(minLow20) ? maxHigh20 - minLow20 : NaN;
  const rangePosition20d =
    Number.isFinite(range20) && Number.isFinite(close) ? (range20 > 0 ? (close - minLow20) / range20 : 0.5) : NaN;
  void closes20ForRange;

  let gapCount10d = 0;
  for (const i of window10) {
    if (i < 1) {
      continue;
    }
    const openI = numAt(bars, i, 'o');
    const prevCloseI = numAt(bars, i - 1, 'c');
    if (Number.isFinite(openI) && Number.isFinite(prevCloseI) && prevCloseI > 0) {
      const gapPct = ((openI - prevCloseI) / prevCloseI) * 100;
      if (Math.abs(gapPct) > 3) {
        gapCount10d += 1;
      }
    }
  }

  const dailyChange = Number.isFinite(prevClose) && prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : NaN;

  return {
    volumeRatio1d,
    volumeRatio3d,
    volumeTrend5d,
    adrPct20d,
    adrContraction,
    consolidationScore,
    highProximity60d,
    distFromLow60d,
    return5d,
    return20d,
    ma50Slope,
    priceVsMa50,
    priceVsMa200,
    rangePosition20d,
    gapCount10d,
    dailyChange
  };
}

// Computes features for every index in [minIndex, bars.length - 1]. Callers apply row-eligibility
// filtering (docs/SPEC_ANOMALY_MINING.md section 2.3) separately - this function only computes.
function computeFeatureRows({ bars, minIndex = 0 }) {
  const rows = [];
  for (let t = minIndex; t < bars.length; t += 1) {
    rows.push({ index: t, date: bars[t].t, features: computeFeaturesAt(bars, t) });
  }
  return rows;
}

module.exports = {
  FEATURE_NAMES,
  computeFeaturesAt,
  computeFeatureRows
};
