const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreStockByStrategy, STRATEGY_LABELS } = require('../src/services/strategies');
const { computeRsi, computeTrailingReturnPct } = require('../src/services/mathUtils');

// A stock in a clean uptrend that has pulled back ~10% off its high, back to just above MA50, on
// light volume - the textbook setup pullback_uptrend is meant to find.
function pullbackFixture(overrides = {}) {
  return {
    ticker: 'PB',
    price: 90,
    daily_change: -0.5,
    gap_pct: 0,
    volume: 600000,
    average_volume_30d: 1000000,
    market_cap: 5000000000,
    MA50: 88,
    MA200: 75,
    high_52w: 100,
    low_52w: 60,
    volatility: 0.03,
    return_3m: 12,
    revenue_growth_pct: 10,
    adr_pct: 3,
    ma50_slope: 0.02,
    price_near_daily_high: 0.95,
    consolidation_score: 0.5,
    rsi_14: 45,
    return_5d: -3,
    imputedFields: [],
    ...overrides
  };
}

// Same universe, but a stock that just got hit hard while still holding its long-term trend.
function bounceFixture(overrides = {}) {
  return pullbackFixture({ rsi_14: 25, return_5d: -12, volume: 2500000, price: 82, ...overrides });
}

test('both new strategies are registered with labels', () => {
  assert.ok(STRATEGY_LABELS.pullback_uptrend);
  assert.ok(STRATEGY_LABELS.mean_reversion_bounce);
});

test('pullback_uptrend scores the textbook setup and explains it', () => {
  const result = scoreStockByStrategy('pullback_uptrend', pullbackFixture(), { benchmarkReturn3m: 3 });

  assert.equal(result.eligibility.passed, true);
  assert.ok(result.score > 0.5, `expected a strong score, got ${result.score}`);
  const summed = result.scoreBreakdown.reduce((total, factor) => total + factor.contribution, 0);
  assert.ok(Math.abs(summed - result.score) < 0.005);
});

test('pullback_uptrend rejects a downtrend outright - it is not a dip if MA50 is below MA200', () => {
  const result = scoreStockByStrategy('pullback_uptrend', pullbackFixture({ MA50: 70, MA200: 95, price: 65 }), {
    benchmarkReturn3m: 3
  });

  assert.equal(result.score, 0);
  assert.equal(result.eligibility.passed, false);
});

test('pullback_uptrend rejects both a too-shallow and a too-deep pullback', () => {
  const shallow = scoreStockByStrategy('pullback_uptrend', pullbackFixture({ price: 99 }), { benchmarkReturn3m: 3 });
  const broken = scoreStockByStrategy('pullback_uptrend', pullbackFixture({ price: 70 }), { benchmarkReturn3m: 3 });

  assert.equal(shallow.eligibility.passed, false, 'a 1% dip is noise, not a pullback');
  assert.equal(broken.eligibility.passed, false, 'a 30% drop is a broken trend, not a dip');
});

// This is the one place in the codebase where LOW volume scores higher, so it is worth pinning.
test('pullback_uptrend rewards drying-up volume rather than expanding volume', () => {
  const quiet = scoreStockByStrategy('pullback_uptrend', pullbackFixture({ volume: 500000 }), { benchmarkReturn3m: 3 });
  const heavy = scoreStockByStrategy('pullback_uptrend', pullbackFixture({ volume: 2000000 }), { benchmarkReturn3m: 3 });

  const quietVolume = quiet.scoreBreakdown.find((factor) => factor.key === 'volumeDryUp');
  const heavyVolume = heavy.scoreBreakdown.find((factor) => factor.key === 'volumeDryUp');

  assert.ok(quietVolume.value > heavyVolume.value, 'heavy volume on a decline is distribution, not a dip');
});

test('mean_reversion_bounce scores an oversold stock that is still above MA200', () => {
  const result = scoreStockByStrategy('mean_reversion_bounce', bounceFixture(), { benchmarkReturn3m: 3 });

  assert.equal(result.eligibility.passed, true);
  assert.ok(result.score > 0.5, `expected a strong score, got ${result.score}`);
  const summed = result.scoreBreakdown.reduce((total, factor) => total + factor.contribution, 0);
  assert.ok(Math.abs(summed - result.score) < 0.005);
});

// The trend gate is the whole safety mechanism - without it this strategy buys stocks going to zero.
test('mean_reversion_bounce refuses a falling knife below MA200 no matter how oversold', () => {
  const knife = scoreStockByStrategy(
    'mean_reversion_bounce',
    bounceFixture({ price: 40, MA200: 75, rsi_14: 12, return_5d: -30 }),
    { benchmarkReturn3m: 3 }
  );

  assert.equal(knife.score, 0);
  assert.equal(knife.eligibility.passed, false);
});

test('mean_reversion_bounce refuses to score when RSI could not be computed', () => {
  const noHistory = scoreStockByStrategy('mean_reversion_bounce', bounceFixture({ rsi_14: null, return_5d: null }), {
    benchmarkReturn3m: 3
  });

  assert.equal(noHistory.score, 0);
  assert.equal(noHistory.eligibility.passed, false);
  assert.match(noHistory.eligibility.reason, /היסטוריית מחירים/);
});

test('computeRsi returns null rather than a fabricated neutral 50 on short history', () => {
  assert.equal(computeRsi([1, 2, 3], 14), null);
  assert.equal(computeTrailingReturnPct([1, 2, 3], 5), null);
});

test('computeRsi reads oldest-first and reports overbought vs oversold correctly', () => {
  const rising = Array.from({ length: 30 }, (unused, index) => 100 + index);
  const falling = Array.from({ length: 30 }, (unused, index) => 100 - index);

  assert.ok(computeRsi(rising, 14) > 70, 'a monotonic rise should read overbought');
  assert.ok(computeRsi(falling, 14) < 30, 'a monotonic fall should read oversold');
});

test('computeTrailingReturnPct measures the last N bars from an oldest-first series', () => {
  // 100 -> 110 over the final 5 bars.
  const closes = [90, 95, 100, 102, 104, 106, 108, 110];
  assert.equal(Math.round(computeTrailingReturnPct(closes, 5)), 10);
});
