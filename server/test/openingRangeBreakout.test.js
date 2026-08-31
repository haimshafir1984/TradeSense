const test = require('node:test');
const assert = require('node:assert/strict');

const playbook = require('../src/playbooks/openingRangeBreakout');

function stock(overrides = {}) {
  return {
    symbol: 'ORB',
    price: 51,
    atr14: 2,
    openingRangeHigh: 50,
    openingRangeLow: 48,
    openingRangeDirection: 'up',
    rvol: 3,
    rvolBasis: 'opening',
    ...overrides
  };
}

test('registers with the expected key, hypothesis status, aggressive-only tier, and requiresIntraday: true', () => {
  assert.equal(playbook.key, 'opening_range_breakout');
  assert.equal(playbook.status, 'hypothesis');
  assert.deepEqual(playbook.allowedRiskTiers, ['aggressive']);
  assert.equal(playbook.requiresIntraday, true);
});

test('the evidence note discloses that the edge came from the selection filter, not the pattern, and the zero-slippage assumption', () => {
  assert.match(playbook.evidence.note, /פילטר הבחירה/);
  assert.match(playbook.evidence.note, /slippage/);
});

test('a genuine upside breakout on opening-based rvol is eligible with a valid, very-tight-stop plan', () => {
  const result = playbook.evaluate(stock());

  assert.equal(result.eligible, true);
  assert.equal(result.plan.valid, true);
  // stop = 0.10 * atr14(2) = 0.2 -> stop price = 51 - 0.2 = 50.8
  assert.equal(result.plan.stop.price, 50.8);
  assert.equal(result.plan.timeStopDays, 1);
});

test('a genuine downside breakdown (short direction) is eligible with the stop above entry', () => {
  const result = playbook.evaluate(
    stock({ price: 47, openingRangeDirection: 'down', openingRangeHigh: 50, openingRangeLow: 48 })
  );

  assert.equal(result.eligible, true);
  // stop = 0.10 * atr14(2) = 0.2 -> stop price = 47 + 0.2 = 47.2 (above entry for a short)
  assert.equal(result.plan.stop.price, 47.2);
});

test('is ineligible without opening-range data - the permanent state while ORB stays unwired into the pipeline', () => {
  const result = playbook.evaluate(stock({ openingRangeHigh: null, openingRangeLow: null }));

  assert.equal(result.eligible, false);
  assert.match(result.reason, /תוך-יומיים/);
  assert.equal(result.plan, null);
});

test('rejects when price has not actually broken beyond the opening range in the candle\'s direction', () => {
  const notBroken = playbook.evaluate(stock({ price: 49.5 })); // below openingRangeHigh=50, direction 'up'
  assert.equal(notBroken.eligible, false);
  assert.match(notBroken.reason, /פרץ/);
});

test('rejects when rvol is not opening-basis - daily rvol is not a substitute for this playbook', () => {
  const result = playbook.evaluate(stock({ rvolBasis: 'daily' }));
  assert.equal(result.eligible, false);
  assert.match(result.reason, /rvolOpening/);
});

test('rejects when the opening candle has no clear direction', () => {
  const result = playbook.evaluate(stock({ openingRangeDirection: null }));
  assert.equal(result.eligible, false);
  assert.match(result.reason, /כיוון/);
});

test('missing atr14 invalidates the plan and the candidate is rejected, not shown with a broken plan', () => {
  const result = playbook.evaluate(stock({ atr14: null }));

  assert.equal(result.eligible, false);
  assert.equal(result.plan, null);
  assert.match(result.reason, /atr14/);
});

test('evaluate is deterministic given the same stock object (no hidden clock/global state)', () => {
  const input = stock();
  const first = playbook.evaluate(input);
  const second = playbook.evaluate(input);
  assert.deepEqual(first, second);
});

test('sizing is null without accountRiskUsd and populated when it is provided via context', () => {
  const withoutBudget = playbook.evaluate(stock());
  const withBudget = playbook.evaluate(stock(), { accountRiskUsd: 50 });

  assert.equal(withoutBudget.plan.sizing, null);
  assert.ok(withBudget.plan.sizing.shares >= 0);
});
