const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreStockByStrategy } = require('../src/services/strategies');

function baseStock(overrides = {}) {
  return {
    ticker: 'SCAP',
    price: 15,
    daily_change: 2,
    volume: 2000000,
    average_volume_30d: 1000000,
    market_cap: 500000000,
    high_52w: 16,
    low_52w: 8,
    MA50: 14,
    MA200: 12,
    volatility: 0.04,
    return_3m: 15,
    consolidation_score: 0.5,
    adr_pct: 8,
    gap_pct: 0,
    ...overrides
  };
}

test('eligibility filter zeroes the score for a mega-cap stock', () => {
  const result = scoreStockByStrategy('small_cap_breakout', baseStock({ market_cap: 50000000000 }), { benchmarkReturn3m: 0 });
  assert.equal(result.score, 0);
});

test('eligibility filter zeroes the score for a sub-$2 stock', () => {
  const result = scoreStockByStrategy('small_cap_breakout', baseStock({ price: 1.5 }), { benchmarkReturn3m: 0 });
  assert.equal(result.score, 0);
});

test('eligibility filter zeroes the score for a stock with ADR below 5%', () => {
  const result = scoreStockByStrategy('small_cap_breakout', baseStock({ adr_pct: 3 }), { benchmarkReturn3m: 0 });
  assert.equal(result.score, 0);
});

test('a stock passing eligibility scores above zero', () => {
  const result = scoreStockByStrategy('small_cap_breakout', baseStock(), { benchmarkReturn3m: 0 });
  assert.ok(result.score > 0);
});

test('a bigger volume surge scores higher, all else equal', () => {
  const weakVolume = scoreStockByStrategy('small_cap_breakout', baseStock({ volume: 2000000 }), { benchmarkReturn3m: 0 });
  const strongVolume = scoreStockByStrategy('small_cap_breakout', baseStock({ volume: 4000000 }), { benchmarkReturn3m: 0 });

  assert.ok(strongVolume.score > weakVolume.score);
});

test('a bigger gap scores higher than a small gap, all else equal', () => {
  const smallGap = scoreStockByStrategy('small_cap_breakout', baseStock({ gap_pct: 5, daily_change: 1 }), { benchmarkReturn3m: 0 });
  const bigGap = scoreStockByStrategy('small_cap_breakout', baseStock({ gap_pct: 15, daily_change: 1 }), { benchmarkReturn3m: 0 });

  assert.ok(bigGap.score > smallGap.score);
});
