const test = require('node:test');
const assert = require('node:assert/strict');

const playbook = require('../src/playbooks/shortTermReversal');

function stock(overrides = {}) {
  return {
    symbol: 'RVRS',
    price: 82,
    atr14: 3,
    ma20: 90,
    ma200: 75,
    rsi14: 25,
    return5d: -12,
    rvol: 2.5,
    ...overrides
  };
}

test('registers with the expected key, hypothesis status, and evidence sources', () => {
  assert.equal(playbook.key, 'short_term_reversal');
  assert.equal(playbook.status, 'hypothesis');
  assert.ok(playbook.evidence.sources.some((source) => source.includes('Lehmann')));
});

test('a textbook oversold-bounce-in-uptrend setup is eligible with a valid plan', () => {
  const result = playbook.evaluate(stock());

  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
  assert.equal(result.plan.valid, true);
  assert.ok(result.conviction > 0 && result.conviction <= 1);
  assert.ok(result.factors.length > 0);
});

test('rejects a falling knife below MA200 no matter how oversold - the safety gate is absolute', () => {
  const result = playbook.evaluate(stock({ price: 60, ma200: 75, rsi14: 10, return5d: -30 }));

  assert.equal(result.eligible, false);
  assert.match(result.reason, /ממוצע 200/);
  assert.equal(result.plan, null);
});

test('rejects a shallow drop (return5d above the -8% trigger) even if everything else qualifies', () => {
  const result = playbook.evaluate(stock({ return5d: -3 }));

  assert.equal(result.eligible, false);
  assert.match(result.reason, /ירידה/);
});

test('rejects when RSI is not oversold enough, independently of the other gates', () => {
  const result = playbook.evaluate(stock({ rsi14: 45 }));

  assert.equal(result.eligible, false);
  assert.match(result.reason, /RSI/);
});

test('rejects when relative volume is below the trigger, independently of the other gates', () => {
  const result = playbook.evaluate(stock({ rvol: 1.2 }));

  assert.equal(result.eligible, false);
  assert.match(result.reason, /נפח יחסי/);
});

test('missing atr14 invalidates the plan and the candidate is rejected, not shown with a broken plan', () => {
  const result = playbook.evaluate(stock({ atr14: null }));

  assert.equal(result.eligible, false);
  assert.equal(result.plan, null);
  assert.match(result.reason, /atr14/);
});

test('target is the nearer of MA20-reclaim or 2R, never a distant unreachable target', () => {
  // MA20 far overhead (huge R multiple) should be capped at 2R.
  const capped = playbook.evaluate(stock({ ma20: 500 }));
  assert.equal(capped.plan.target.rMultiple, 2);

  // MA20 close by (smaller R multiple than 2) should be used instead of the fallback.
  const nearMa20 = playbook.evaluate(stock({ price: 82, ma20: 84, atr14: 3 })); // (84-82)/(1.5*3)=0.44R
  assert.ok(nearMa20.plan.target.rMultiple < 2);
});

test('evaluate is deterministic given the same stock object (no hidden clock/global state)', () => {
  const input = stock();
  const first = playbook.evaluate(input);
  const second = playbook.evaluate(input);
  assert.deepEqual(first, second);
});

test('sizing is null without accountRiskUsd and populated when it is provided via context', () => {
  const withoutBudget = playbook.evaluate(stock());
  const withBudget = playbook.evaluate(stock(), { accountRiskUsd: 100 });

  assert.equal(withoutBudget.plan.sizing, null);
  assert.ok(withBudget.plan.sizing.shares >= 0);
});
