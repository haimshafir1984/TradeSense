const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreStockByStrategy } = require('../src/services/strategies');

function baseStock(overrides = {}) {
  return {
    ticker: 'TEST',
    price: 100,
    daily_change: 1,
    volume: 1000000,
    average_volume_30d: 900000,
    market_cap: 5000000000,
    high_52w: 110,
    low_52w: 90,
    MA50: 98,
    MA200: 95,
    volatility: 0.02,
    return_3m: 5,
    revenue_growth_pct: 0,
    ...overrides
  };
}

test('micha_stocks rewards real revenue growth, not just market-cap size', () => {
  const flatGrowth = scoreStockByStrategy('micha_stocks', baseStock({ revenue_growth_pct: 0 }), { benchmarkReturn3m: 0 });
  const strongGrowth = scoreStockByStrategy('micha_stocks', baseStock({ revenue_growth_pct: 20 }), { benchmarkReturn3m: 0 });

  assert.ok(strongGrowth.score > flatGrowth.score);
});

test('two stocks with identical market cap but different revenue growth score differently', () => {
  const sameCapLowGrowth = scoreStockByStrategy('micha_stocks', baseStock({ market_cap: 10000000000, revenue_growth_pct: -5 }), { benchmarkReturn3m: 0 });
  const sameCapHighGrowth = scoreStockByStrategy('micha_stocks', baseStock({ market_cap: 10000000000, revenue_growth_pct: 15 }), { benchmarkReturn3m: 0 });

  assert.ok(sameCapHighGrowth.score > sameCapLowGrowth.score);
});
