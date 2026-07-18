const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSmoothedRegime } = require('../src/services/marketRegimeService');

test('returns null for an empty history (caller falls back to the current regime)', () => {
  assert.equal(computeSmoothedRegime([]), null);
});

test('a single entry is returned as-is', () => {
  const result = computeSmoothedRegime([{ date: '2026-07-10', regime: 'bullish' }]);
  assert.equal(result, 'bullish');
});

test('majority vote across the last 3 days: [bullish, bearish, bearish] -> bearish', () => {
  const result = computeSmoothedRegime([
    { date: '2026-07-08', regime: 'bullish' },
    { date: '2026-07-09', regime: 'bearish' },
    { date: '2026-07-10', regime: 'bearish' }
  ]);
  assert.equal(result, 'bearish');
});

test('a tie is broken by recency (today wins)', () => {
  const result = computeSmoothedRegime([
    { date: '2026-07-09', regime: 'bearish' },
    { date: '2026-07-10', regime: 'bullish' }
  ]);
  assert.equal(result, 'bullish');
});

test('only the most recent 3 entries are considered, even with a longer history', () => {
  const result = computeSmoothedRegime([
    { date: '2026-07-01', regime: 'bearish' },
    { date: '2026-07-02', regime: 'bearish' },
    { date: '2026-07-03', regime: 'bearish' },
    { date: '2026-07-08', regime: 'bullish' },
    { date: '2026-07-09', regime: 'bullish' },
    { date: '2026-07-10', regime: 'volatile' }
  ]);
  // Only the last 3 (bullish, bullish, volatile) count -> bullish, not the older bearish run.
  assert.equal(result, 'bullish');
});
