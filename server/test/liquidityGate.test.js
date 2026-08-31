const test = require('node:test');
const assert = require('node:assert/strict');

const { applyLiquidityGate, THRESHOLDS } = require('../src/pipeline/liquidityGate');

function goodStock(overrides = {}) {
  return {
    symbol: 'GOOD',
    price: 20,
    avgVolume20d: 2000000,
    atr14: 1.2,
    barCount: 250,
    ...overrides
  };
}

test('a stock meeting every threshold passes', () => {
  const { passed, rejected } = applyLiquidityGate([goodStock()]);
  assert.equal(passed.length, 1);
  assert.equal(rejected.length, 0);
});

test('a stock below the minimum price is rejected with a price-specific reason', () => {
  const { passed, rejected } = applyLiquidityGate([goodStock({ symbol: 'CHEAP', price: 1 })]);
  assert.equal(passed.length, 0);
  assert.equal(rejected[0].symbol, 'CHEAP');
  assert.match(rejected[0].reason, /מחיר/);
});

test('a stock below the minimum average volume is rejected with a volume-specific reason', () => {
  const { rejected } = applyLiquidityGate([goodStock({ symbol: 'THIN', avgVolume20d: 10000 })]);
  assert.match(rejected[0].reason, /נפח/);
});

test('a stock below the minimum ATR14 is rejected with an ATR-specific reason', () => {
  const { rejected } = applyLiquidityGate([goodStock({ symbol: 'QUIET', atr14: 0.1 })]);
  assert.match(rejected[0].reason, /ATR14/);
});

test('a stock with too little bar history is rejected with a history-specific reason', () => {
  const { rejected } = applyLiquidityGate([goodStock({ symbol: 'NEW', barCount: 50 })]);
  assert.match(rejected[0].reason, /נרות היסטוריה/);
});

test('missing/non-finite fields are rejected, not treated as passing zeros', () => {
  const { rejected } = applyLiquidityGate([goodStock({ symbol: 'NULLS', atr14: null, avgVolume20d: NaN })]);
  assert.equal(rejected.length, 1);
});

test('every rejected entry carries its symbol and a non-empty reason', () => {
  const { rejected } = applyLiquidityGate([
    goodStock({ symbol: 'A', price: 1 }),
    goodStock({ symbol: 'B', atr14: 0 })
  ]);
  for (const entry of rejected) {
    assert.ok(entry.symbol);
    assert.ok(entry.reason && entry.reason.length > 0);
  }
});

test('an empty input returns empty passed and rejected without throwing', () => {
  const { passed, rejected } = applyLiquidityGate([]);
  assert.deepEqual(passed, []);
  assert.deepEqual(rejected, []);
});

test('price/ATR14/bar-count thresholds match the ORB paper source values documented in §5.0', () => {
  assert.equal(THRESHOLDS.minPrice, 5);
  assert.equal(THRESHOLDS.minAtr14, 0.5);
  assert.equal(THRESHOLDS.minBarCount, 200);
});

// The volume threshold is deliberately NOT the paper's raw 1,000,000 - it's rescaled for the free
// iex feed's measured ~4% coverage of real market volume (see the comment above THRESHOLDS in
// liquidityGate.js). Pinned here so a future edit has to be a deliberate, documented choice.
test('the volume threshold is rescaled ~25x down from the paper value for the iex feed, not the raw SIP figure', () => {
  assert.equal(THRESHOLDS.minAvgVolume20d, 40000);
});
