const test = require('node:test');
const assert = require('node:assert/strict');
const { isEligibleRow, labelEvent } = require('../src/services/research/eventLabeler');

function bar(c, v = 500000, extra = {}) {
  return { t: '2026-01-01T00:00:00Z', o: c, h: c * 1.01, l: c * 0.99, c, v, ...extra };
}

test('labelEvent: exactly at the threshold (12.0%) is labeled an event', () => {
  const bars = [bar(100), bar(112)];
  const result = labelEvent(bars, 0, { thresholdPct: 12 });
  assert.equal(result.labeled, true);
  assert.equal(result.isEvent, true);
});

test('labelEvent: just under the threshold (11.9%) is not an event', () => {
  const bars = [bar(100), bar(111.9)];
  const result = labelEvent(bars, 0, { thresholdPct: 12 });
  assert.equal(result.labeled, true);
  assert.equal(result.isEvent, false);
});

test('labelEvent: a 250% jump is rejected as a data artifact, not labeled an event', () => {
  const bars = [bar(100), bar(350)];
  const result = labelEvent(bars, 0, { thresholdPct: 12 });
  assert.equal(result.labeled, false);
  assert.equal(result.isEvent, null);
  assert.equal(result.reason, 'artifact');
});

test('labelEvent: missing next bar is not labeled (not treated as a negative example)', () => {
  const bars = [bar(100)];
  const result = labelEvent(bars, 0);
  assert.equal(result.labeled, false);
  assert.equal(result.isEvent, null);
});

test('labelEvent: zero volume on the next bar is not labeled', () => {
  const bars = [bar(100), bar(112, 0)];
  const result = labelEvent(bars, 0);
  assert.equal(result.labeled, false);
  assert.equal(result.reason, 'zero-volume');
});

function buildHistory(count, price = 20, volume = 500000) {
  return Array.from({ length: count }, () => bar(price, volume));
}

test('isEligibleRow: rejects a row with fewer than 210 prior bars', () => {
  const bars = buildHistory(209).concat([bar(20)]); // index 209 has only 210 bars total but no next bar
  const result = isEligibleRow(bars, 208); // index 208 -> only 209 bars up to and including it
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'insufficient-history');
});

test('isEligibleRow: accepts a row with exactly 210 prior bars, in price/volume range, and a next bar', () => {
  const bars = buildHistory(211, 20, 500000); // indices 0..210, so index 209 has 210 bars (0..209) plus a next bar at 210
  const result = isEligibleRow(bars, 209, { minPrice: 2, maxPrice: 500, minDollarVolume: 1000000 });
  assert.equal(result.eligible, true);
});

test('isEligibleRow: rejects a row priced below the floor', () => {
  const bars = buildHistory(211, 1, 500000);
  const result = isEligibleRow(bars, 209, { minPrice: 2, maxPrice: 500 });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'price-out-of-range');
});

test('isEligibleRow: rejects a row whose median dollar volume is below the floor', () => {
  const bars = buildHistory(211, 20, 1000); // 20 * 1000 = 20,000 dollar volume, well under 1,000,000
  const result = isEligibleRow(bars, 209, { minDollarVolume: 1000000 });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'low-dollar-volume');
});

test('isEligibleRow: rejects a row with no next bar (last bar in the series)', () => {
  const bars = buildHistory(210, 20, 500000);
  const result = isEligibleRow(bars, 209);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'no-next-bar');
});
