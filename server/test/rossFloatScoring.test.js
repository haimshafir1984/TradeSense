const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreStockByStrategy } = require('../src/services/strategies');

// Base stock with a mega-cap market_cap (proxy tier: > 10B -> 0.25) so a real, low share count
// (tier: <= 20M -> 1) produces a clearly different float score - isolates the float sub-factor
// from the rest of ross_cameron's formula (momentum/volume/breakout stay identical in both cases).
function baseStock(overrides = {}) {
  return {
    ticker: 'RC1',
    price: 20,
    daily_change: 8,
    volume: 3000000,
    average_volume_30d: 1000000,
    high_52w: 20.5,
    price_near_daily_high: 0.97,
    market_cap: 50000000000,
    ...overrides
  };
}

test('scoreRossStrategy uses the market-cap proxy (and reports floatSource: proxy) when no real share count is given', () => {
  const result = scoreStockByStrategy('ross_cameron', baseStock());

  assert.equal(result.floatSource, 'proxy');
});

test('scoreRossStrategy uses a real share-count tier (and reports floatSource: real) when shareOutstanding is present, changing the score', () => {
  const withoutRealFloat = scoreStockByStrategy('ross_cameron', baseStock());
  const withRealFloat = scoreStockByStrategy('ross_cameron', baseStock({ shareOutstanding: 15000000 })); // 15M shares -> tier 1

  assert.equal(withRealFloat.floatSource, 'real');
  assert.ok(withRealFloat.score > withoutRealFloat.score);
});

test('an implausible shareOutstanding (missing/zero/negative) falls back to the proxy, leaving the score unchanged', () => {
  const baseline = scoreStockByStrategy('ross_cameron', baseStock());
  const withZero = scoreStockByStrategy('ross_cameron', baseStock({ shareOutstanding: 0 }));
  const withNegative = scoreStockByStrategy('ross_cameron', baseStock({ shareOutstanding: -5 }));
  const withNonFinite = scoreStockByStrategy('ross_cameron', baseStock({ shareOutstanding: NaN }));

  assert.equal(withZero.score, baseline.score);
  assert.equal(withZero.floatSource, 'proxy');
  assert.equal(withNegative.score, baseline.score);
  assert.equal(withNonFinite.score, baseline.score);
});
