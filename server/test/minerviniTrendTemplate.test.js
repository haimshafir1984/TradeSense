const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreStockByStrategy } = require('../src/services/strategies');

function baseStock(overrides = {}) {
  return {
    ticker: 'TEST',
    price: 100,
    daily_change: 3,
    volume: 1500000,
    average_volume_30d: 1000000,
    market_cap: 5000000000,
    high_52w: 105,
    low_52w: 90,
    MA50: 95,
    MA200: 92,
    volatility: 0.02,
    return_3m: 12,
    consolidation_score: 0.3,
    ma50_slope: 0.01,
    price_near_daily_high: 0.95,
    ...overrides
  };
}

test('Minervini score rewards being well above the 52-week low (trend template)', () => {
  const nearLow = scoreStockByStrategy('mark_minervini', baseStock({ low_52w: 96 }), { benchmarkReturn3m: 5 });
  const farFromLow = scoreStockByStrategy('mark_minervini', baseStock({ low_52w: 70 }), { benchmarkReturn3m: 5 });

  assert.ok(farFromLow.score > nearLow.score);
  assert.ok(farFromLow.aboveLow52Pct > nearLow.aboveLow52Pct);
});

test('Minervini score rewards tight consolidation (VCP) ahead of breakout', () => {
  const loose = scoreStockByStrategy('mark_minervini', baseStock({ consolidation_score: 0.1 }), { benchmarkReturn3m: 5 });
  const tight = scoreStockByStrategy('mark_minervini', baseStock({ consolidation_score: 0.9 }), { benchmarkReturn3m: 5 });

  assert.ok(tight.score > loose.score);
});

test('Minervini score rewards correct MA ordering (MA50 > MA200)', () => {
  const badOrder = scoreStockByStrategy('mark_minervini', baseStock({ MA50: 90, MA200: 95 }), { benchmarkReturn3m: 5 });
  const goodOrder = scoreStockByStrategy('mark_minervini', baseStock({ MA50: 95, MA200: 90 }), { benchmarkReturn3m: 5 });

  assert.ok(goodOrder.score > badOrder.score);
});
