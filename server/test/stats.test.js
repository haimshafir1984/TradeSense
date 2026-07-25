const test = require('node:test');
const assert = require('node:assert/strict');
const { wilsonLowerBound, lift } = require('../src/services/research/stats');

test('wilsonLowerBound matches known values (spec section 6.3 / 8.7)', () => {
  assert.ok(Math.abs(wilsonLowerBound(3, 4) - 0.301) < 0.002);
  assert.ok(Math.abs(wilsonLowerBound(200, 1500) - 0.117) < 0.002);
});

test('wilsonLowerBound favors a large certain sample over a small sample with a slightly higher raw proportion', () => {
  // 6/10 = 60% raw (small, uncertain) vs 550/1000 = 55% raw (large, tight CI). This is the
  // property the ranking in section 6.3 relies on: a bigger sample with a *lower* raw proportion
  // can still outrank a small one, because the Wilson interval accounts for how much the raw
  // proportion could be wrong given the sample size.
  assert.ok(wilsonLowerBound(6, 10) < wilsonLowerBound(550, 1000));
});

test('wilsonLowerBound returns 0 for n=0 without dividing by zero', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
});

test('lift is the ratio of p to baseRate', () => {
  assert.equal(lift(0.5, 0.1), 5);
  assert.ok(Math.abs(lift(0.02, 0.1) - 0.2) < 1e-9);
});

test('lift guards against a zero or invalid base rate', () => {
  assert.equal(lift(0.5, 0), 0);
  assert.equal(lift(0.5, NaN), 0);
});
