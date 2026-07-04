const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreStockByStrategy } = require('../src/services/strategies');

function baseStock(overrides = {}) {
  return {
    ticker: 'TEST',
    price: 100,
    daily_change: 1,
    volume: 1000000,
    average_volume_30d: 1000000,
    market_cap: 5000000000,
    high_52w: 105,
    low_52w: 70,
    MA50: 95,
    MA200: 90,
    volatility: 0.02,
    return_3m: 10,
    consolidation_score: 0.3,
    adr_pct: 5,
    gap_pct: 0,
    ...overrides
  };
}

test('breakout sub-setup rewards tight consolidation resolving near highs on volume', () => {
  const weakBreakout = scoreStockByStrategy(
    'swing_momentum',
    baseStock({ consolidation_score: 0.2, price: 91, volume: 1000000 }),
    { benchmarkReturn3m: 0 }
  );
  const strongBreakout = scoreStockByStrategy(
    'swing_momentum',
    baseStock({ consolidation_score: 0.9, price: 103, volume: 3000000 }),
    { benchmarkReturn3m: 0 }
  );

  assert.ok(strongBreakout.score > weakBreakout.score);
  assert.equal(strongBreakout.swingSetup, 'breakout');
});

test('episodic pivot sub-setup rewards a large gap with a volume surge over a quiet stock', () => {
  const noPivot = scoreStockByStrategy(
    'swing_momentum',
    baseStock({ gap_pct: 1, daily_change: 1, volume: 1000000, consolidation_score: 0, price: 91, high_52w: 200 }),
    { benchmarkReturn3m: 0 }
  );
  const pivot = scoreStockByStrategy(
    'swing_momentum',
    baseStock({ gap_pct: 15, daily_change: 15, volume: 4000000, consolidation_score: 0, price: 91, high_52w: 200 }),
    { benchmarkReturn3m: 0 }
  );

  assert.ok(pivot.score > noPivot.score);
  assert.equal(pivot.swingSetup, 'episodic_pivot');
});

test('ADR eligibility filter zeroes the score for a dormant stock even with a strong breakout setup', () => {
  const dormant = scoreStockByStrategy(
    'swing_momentum',
    baseStock({ adr_pct: 1.5, consolidation_score: 0.9, price: 103, high_52w: 105, volume: 3000000 }),
    { benchmarkReturn3m: 0 }
  );
  const active = scoreStockByStrategy(
    'swing_momentum',
    baseStock({ adr_pct: 5, consolidation_score: 0.9, price: 103, high_52w: 105, volume: 3000000 }),
    { benchmarkReturn3m: 0 }
  );

  assert.equal(dormant.score, 0);
  assert.ok(active.score > 0);
});

test('a stock trading below MA200 is disqualified regardless of ADR', () => {
  const belowTrend = scoreStockByStrategy(
    'swing_momentum',
    baseStock({ adr_pct: 6, price: 85, MA200: 90, consolidation_score: 0.9, high_52w: 90, volume: 3000000 }),
    { benchmarkReturn3m: 0 }
  );

  assert.equal(belowTrend.score, 0);
});

test('analyzeMarket runs end-to-end on demo data for the swing_momentum strategy', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;
  const { analyzeMarket } = require('../src/services/scannerService');

  const response = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'swing_momentum',
    risk: 'medium',
    filters: {}
  });

  assert.ok(Array.isArray(response.results));
  assert.equal(response.meta.strategy, 'swing_momentum');
  for (const result of response.results) {
    assert.equal(result.strategyName, 'פריצות מומנטום (Swing)');
  }
});
