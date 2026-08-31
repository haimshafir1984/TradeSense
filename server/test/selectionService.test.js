const test = require('node:test');
const assert = require('node:assert/strict');

const { rankByRelativeVolume } = require('../src/pipeline/selectionService');

function stock(symbol, volume, avgVolume14d, overrides = {}) {
  return { symbol, volume, avgVolume14d, ...overrides };
}

test('ranks by rvolDaily (volume / avgVolume14d) descending', () => {
  const stocks = [stock('LOW', 1000000, 1000000), stock('HIGH', 5000000, 1000000), stock('MID', 2000000, 1000000)];
  const ranked = rankByRelativeVolume(stocks, { topN: 10 });

  assert.deepEqual(ranked.map((s) => s.symbol), ['HIGH', 'MID', 'LOW']);
  assert.equal(ranked[0].rvol, 5);
  assert.equal(ranked[0].rvolBasis, 'daily');
});

test('caps results at topN even when more stocks qualify', () => {
  const stocks = Array.from({ length: 30 }, (unused, i) => stock(`S${i}`, 1000000 + i, 1000000));
  const ranked = rankByRelativeVolume(stocks, { topN: 5 });
  assert.equal(ranked.length, 5);
});

test('excludes a stock with missing/zero avgVolume14d instead of ranking it with a fake rvol', () => {
  const stocks = [stock('OK', 2000000, 1000000), stock('NODATA', 2000000, null), stock('ZERO', 2000000, 0)];
  const ranked = rankByRelativeVolume(stocks, { topN: 10 });
  assert.deepEqual(ranked.map((s) => s.symbol), ['OK']);
});

test('prefers rvolOpening over rvolDaily when a stock already carries it (intraday-aware caller)', () => {
  const stocks = [
    stock('DAILY_ONLY', 5000000, 1000000), // rvolDaily = 5
    stock('HAS_OPENING', 1000000, 1000000, { rvolOpening: 8 }) // rvolDaily = 1, but opening = 8
  ];
  const ranked = rankByRelativeVolume(stocks, { topN: 10 });

  assert.equal(ranked[0].symbol, 'HAS_OPENING');
  assert.equal(ranked[0].rvol, 8);
  assert.equal(ranked[0].rvolBasis, 'opening');
});

test('every ranked stock carries the mandatory partial-feed-coverage warning', () => {
  const ranked = rankByRelativeVolume([stock('A', 2000000, 1000000)], { topN: 10 });
  assert.match(ranked[0].rvolWarning, /iex/);
});

test('an empty input returns an empty list without throwing', () => {
  assert.deepEqual(rankByRelativeVolume([], { topN: 10 }), []);
});

test('window=20 uses avgVolume20d instead of avgVolume14d', () => {
  const stocks = [stock('A', 4000000, 999999999, { avgVolume20d: 2000000 })];
  const ranked = rankByRelativeVolume(stocks, { window: 20, topN: 10 });
  assert.equal(ranked[0].rvol, 2);
});
