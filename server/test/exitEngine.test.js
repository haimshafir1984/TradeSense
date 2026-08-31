const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTradePlan } = require('../src/risk/exitEngine');

test('computes stop/target/R correctly for a long plan', () => {
  const plan = buildTradePlan({ entryPrice: 100, atr14: 4, stopMultiple: 2.5, targetR: 3, timeStopDays: 30 });

  assert.equal(plan.valid, true);
  assert.equal(plan.invalidReason, null);
  assert.equal(plan.entry.price, 100);
  // stop distance = 2.5 * 4 = 10 -> stop price = 90
  assert.equal(plan.stop.price, 90);
  assert.equal(plan.stop.distanceR, 1);
  assert.equal(plan.stop.distancePct, 10);
  // target = entry + 3R = 100 + 3*10 = 130
  assert.equal(plan.target.price, 130);
  assert.equal(plan.target.rMultiple, 3);
  assert.equal(plan.target.gainPct, 30);
  assert.equal(plan.timeStopDays, 30);
});

test('computes stop/target correctly for a short plan', () => {
  const plan = buildTradePlan({ entryPrice: 100, atr14: 4, stopMultiple: 1, targetR: 2, timeStopDays: 3, direction: 'short' });

  assert.equal(plan.valid, true);
  // stop distance = 1*4 = 4 -> stop price = 104 (above entry for a short)
  assert.equal(plan.stop.price, 104);
  // target = entry - 2R = 100 - 8 = 92
  assert.equal(plan.target.price, 92);
  assert.equal(plan.target.gainPct, 8);
});

test('missing/invalid atr14 makes the plan invalid with a specific reason', () => {
  const missing = buildTradePlan({ entryPrice: 100, atr14: null, stopMultiple: 2, targetR: 2, timeStopDays: 10 });
  const zero = buildTradePlan({ entryPrice: 100, atr14: 0, stopMultiple: 2, targetR: 2, timeStopDays: 10 });
  const negative = buildTradePlan({ entryPrice: 100, atr14: -1, stopMultiple: 2, targetR: 2, timeStopDays: 10 });

  for (const plan of [missing, zero, negative]) {
    assert.equal(plan.valid, false);
    assert.match(plan.invalidReason, /atr14/);
    assert.equal(plan.entry, null);
    assert.equal(plan.sizing, null);
  }
});

test('an invalid plan carries no entry/stop/target/sizing at all', () => {
  const plan = buildTradePlan({ entryPrice: 0, atr14: 4, stopMultiple: 2, targetR: 2, timeStopDays: 10 });

  assert.equal(plan.valid, false);
  assert.equal(plan.entry, null);
  assert.equal(plan.stop, null);
  assert.equal(plan.target, null);
  assert.equal(plan.sizing, null);
});

test('zero stop distance (stopMultiple or atr14 effectively zero) is invalid', () => {
  const plan = buildTradePlan({ entryPrice: 100, atr14: 4, stopMultiple: 0, targetR: 2, timeStopDays: 10 });

  assert.equal(plan.valid, false);
  assert.match(plan.invalidReason, /סטופ/);
});

test('sizing is null (not zero) when accountRiskUsd is not supplied', () => {
  const plan = buildTradePlan({ entryPrice: 100, atr14: 4, stopMultiple: 2, targetR: 2, timeStopDays: 10 });

  assert.equal(plan.valid, true);
  assert.equal(plan.sizing, null);
});

test('sizing computes shares/riskUsd/notionalUsd from accountRiskUsd and the stop distance', () => {
  // stop distance = 2*4 = 8, risk budget = 200 -> 25 shares
  const plan = buildTradePlan({ entryPrice: 100, atr14: 4, stopMultiple: 2, targetR: 2, timeStopDays: 10, accountRiskUsd: 200 });

  assert.equal(plan.sizing.shares, 25);
  assert.equal(plan.sizing.riskUsd, 200);
  assert.equal(plan.sizing.notionalUsd, 2500);
});

test('sizing floors to zero shares (not negative, not a crash) when the risk budget cannot afford one share', () => {
  const plan = buildTradePlan({ entryPrice: 100, atr14: 4, stopMultiple: 2, targetR: 2, timeStopDays: 10, accountRiskUsd: 1 });

  assert.equal(plan.valid, true);
  assert.equal(plan.sizing.shares, 0);
  assert.equal(plan.sizing.riskUsd, 0);
});

test('an unrecognized direction is invalid rather than silently defaulting', () => {
  const plan = buildTradePlan({ entryPrice: 100, atr14: 4, stopMultiple: 2, targetR: 2, timeStopDays: 10, direction: 'sideways' });

  assert.equal(plan.valid, false);
  assert.match(plan.invalidReason, /כיוון/);
});

test('missing entryPrice, stopMultiple, or targetR each invalidate the plan independently', () => {
  const noEntry = buildTradePlan({ atr14: 4, stopMultiple: 2, targetR: 2, timeStopDays: 10 });
  const noStopMultiple = buildTradePlan({ entryPrice: 100, atr14: 4, targetR: 2, timeStopDays: 10 });
  const noTargetR = buildTradePlan({ entryPrice: 100, atr14: 4, stopMultiple: 2, timeStopDays: 10 });

  assert.equal(noEntry.valid, false);
  assert.equal(noStopMultiple.valid, false);
  assert.equal(noTargetR.valid, false);
});
