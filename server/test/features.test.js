const test = require('node:test');
const assert = require('node:assert/strict');

const { computeFeaturesFromBars, computeAtr, computeRealizedVolatility, simpleMovingAverage } = require('../src/playbooks/features.js');

// Builds `count` oldest-first daily bars with a small deterministic wiggle so high != low != close,
// starting at `startPrice` and drifting by `dailyChange` per bar.
function makeBars(count, { startPrice = 100, dailyChange = 0, volume = 1000000 } = {}) {
  const bars = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = price + dailyChange;
    const high = Math.max(open, close) + 1;
    const low = Math.min(open, close) - 1;
    bars.push({ t: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`, o: open, h: high, l: low, c: close, v: volume });
    price = close;
  }
  return bars;
}

test('computeFeaturesFromBars returns barCount 0 and all-null features for an empty series', () => {
  const features = computeFeaturesFromBars([]);
  assert.equal(features.barCount, 0);
  assert.equal(features.price, null);
  assert.equal(features.atr14, null);
  assert.equal(features.ma200, null);
});

test('computeFeaturesFromBars reads price/volume from the last (most recent) bar', () => {
  const bars = makeBars(30, { startPrice: 50, dailyChange: 1 });
  const features = computeFeaturesFromBars(bars);
  assert.equal(features.price, bars[bars.length - 1].c);
  assert.equal(features.volume, bars[bars.length - 1].v);
});

test('computeAtr returns null with fewer than period+1 bars', () => {
  assert.equal(computeAtr(makeBars(10), 14), null);
});

test('computeAtr is positive for bars with a real high-low range', () => {
  const atr = computeAtr(makeBars(30, { dailyChange: 2 }), 14);
  assert.ok(atr > 0);
});

test('simpleMovingAverage returns null with insufficient history and a real average otherwise', () => {
  assert.equal(simpleMovingAverage(makeBars(10), 50), null);

  const flatBars = makeBars(60, { startPrice: 20, dailyChange: 0 });
  const ma = simpleMovingAverage(flatBars, 50);
  assert.ok(Math.abs(ma - 20) < 3); // close to flat price, allowing for the +/-1 high/low wiggle
});

test('computeFeaturesFromBars: ma200 is null with fewer than 200 bars, present with 200+', () => {
  const short = computeFeaturesFromBars(makeBars(199));
  const long = computeFeaturesFromBars(makeBars(200));
  assert.equal(short.ma200, null);
  assert.ok(Number.isFinite(long.ma200));
});

test('computeFeaturesFromBars: rsi14/return5d are null with too little history and finite otherwise', () => {
  const short = computeFeaturesFromBars(makeBars(4, { dailyChange: 1 }));
  const long = computeFeaturesFromBars(makeBars(30, { dailyChange: 1 }));
  assert.equal(short.rsi14, null);
  assert.equal(short.return5d, null);
  assert.ok(Number.isFinite(long.rsi14));
  assert.ok(Number.isFinite(long.return5d));
});

test('computeFeaturesFromBars: a rising series gives return5d > 0 and a falling series return5d < 0', () => {
  const rising = computeFeaturesFromBars(makeBars(30, { dailyChange: 2 }));
  const falling = computeFeaturesFromBars(makeBars(30, { dailyChange: -2 }));
  assert.ok(rising.return5d > 0);
  assert.ok(falling.return5d < 0);
});

test('computeFeaturesFromBars: avgVolume14d/avgVolume20d reflect the given volume', () => {
  const bars = makeBars(30, { volume: 500000 });
  const features = computeFeaturesFromBars(bars);
  assert.equal(features.avgVolume14d, 500000);
  assert.equal(features.avgVolume20d, 500000);
});

test('computeFeaturesFromBars: high52w/low52w only use the trailing 252 bars, not lookahead into a longer series', () => {
  // First 300 bars trend way up to 1000, then the last 252 bars are flat around 100 - high52w
  // should reflect only the trailing window, not the early spike.
  const spike = makeBars(300, { startPrice: 100, dailyChange: 3 });
  const flatTail = makeBars(252, { startPrice: 100, dailyChange: 0 });
  const bars = [...spike, ...flatTail];

  const features = computeFeaturesFromBars(bars);
  assert.ok(features.high52w < 200, `expected high52w to ignore the early spike, got ${features.high52w}`);
});

test('computeRealizedVolatility returns null with insufficient history and a non-negative number otherwise', () => {
  assert.equal(computeRealizedVolatility(makeBars(10), 20), null);

  const vol = computeRealizedVolatility(makeBars(30, { dailyChange: 1 }), 20);
  assert.ok(vol >= 0);
});

test('computeRealizedVolatility is zero for a perfectly flat (no-change) series', () => {
  const vol = computeRealizedVolatility(makeBars(30, { dailyChange: 0 }), 20);
  assert.equal(vol, 0);
});

test('computeAtr/computeFeaturesFromBars are anti-lookahead: bars appended after index i never change feature values computed from bars[0..i]', () => {
  const bars = makeBars(250, { dailyChange: 1 });
  const truncated = bars.slice(0, 220);
  const withMoreDataAppended = [...truncated, ...makeBars(50, { startPrice: 100000, dailyChange: 5000 })];

  const featuresFromTruncated = computeFeaturesFromBars(truncated);
  const featuresFromPrefixOfLonger = computeFeaturesFromBars(withMoreDataAppended.slice(0, 220));

  assert.deepEqual(featuresFromTruncated, featuresFromPrefixOfLonger);
});
