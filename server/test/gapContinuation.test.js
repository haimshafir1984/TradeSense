const test = require('node:test');
const assert = require('node:assert/strict');

const playbook = require('../src/playbooks/gapContinuation');

function stock(overrides = {}) {
  return {
    symbol: 'GAP',
    price: 22,
    open: 22,
    atr14: 1.5,
    rvol: 3,
    gapPct: 6,
    catalyst: { kind: 'news_spike', confidence: 'medium', premarketGapPct: null },
    ...overrides
  };
}

test('registers with the expected key, hypothesis status, and the mandatory weak-evidence disclosure', () => {
  assert.equal(playbook.key, 'gap_continuation');
  assert.equal(playbook.status, 'hypothesis');
  assert.equal(playbook.evidence.strength, 'weak');
  assert.match(playbook.evidence.note, /לא שפיט/);
  assert.match(playbook.evidence.note, /60%/);
});

test('a large gap with volume confirmation and a real catalyst is eligible with a valid plan', () => {
  const result = playbook.evaluate(stock());

  assert.equal(result.eligible, true);
  assert.equal(result.plan.valid, true);
  assert.equal(result.plan.target.rMultiple, 2);
  assert.equal(result.plan.timeStopDays, 3);
});

test('rejects a gap below the 3% trigger, independently of the other gates', () => {
  const result = playbook.evaluate(stock({ gapPct: 1.5 }));

  assert.equal(result.eligible, false);
  assert.match(result.reason, /גאפ/);
});

test('rejects when relative volume does not confirm the gap', () => {
  const result = playbook.evaluate(stock({ rvol: 1.2 }));

  assert.equal(result.eligible, false);
  assert.match(result.reason, /נפח יחסי/);
});

test('rejects a gap with no identified catalyst - the exact symmetric-noise case', () => {
  const noKind = playbook.evaluate(stock({ catalyst: { kind: null, confidence: 'low' } }));
  const gapNoNews = playbook.evaluate(stock({ catalyst: { kind: 'gap_no_news', confidence: 'low' } }));
  const missing = playbook.evaluate(stock({ catalyst: null }));

  for (const result of [noKind, gapNoNews, missing]) {
    assert.equal(result.eligible, false);
    assert.match(result.reason, /קטליזטור/);
  }
});

test('prefers the live premarket gap over the bar-based approximation when both are present', () => {
  const result = playbook.evaluate(
    stock({ gapPct: 1, catalyst: { kind: 'news_spike', confidence: 'medium', premarketGapPct: 8 } })
  );

  assert.equal(result.eligible, true); // would fail on gapPct=1 alone; live premarketGapPct=8 wins
});

test('missing atr14 invalidates the plan and the candidate is rejected, not shown with a broken plan', () => {
  const result = playbook.evaluate(stock({ atr14: null }));

  assert.equal(result.eligible, false);
  assert.equal(result.plan, null);
  assert.match(result.reason, /atr14/);
});

test('stop falls back to the ATR-only distance when no premarket low is known', () => {
  const result = playbook.evaluate(stock());
  // 1.0 * atr14 = 1.5 -> stop price = 22 - 1.5 = 20.5
  assert.equal(result.plan.stop.price, 20.5);
});

test('stop uses the nearer of ATR distance and the premarket low when the premarket low is known and closer', () => {
  // ATR distance = 1.5 (stop at 20.5); premarket low = 21 -> distance 1, which is nearer.
  const result = playbook.evaluate(stock({ premarketLow: 21 }));
  assert.equal(result.plan.stop.price, 21);
});

test('a premarket low farther away than the ATR distance does not widen the stop', () => {
  // premarket low = 15 -> distance 7, wider than the 1.5 ATR distance - ATR distance should win.
  const result = playbook.evaluate(stock({ premarketLow: 15 }));
  assert.equal(result.plan.stop.price, 20.5);
});

test('evaluate is deterministic given the same stock object (no hidden clock/global state)', () => {
  const input = stock();
  const first = playbook.evaluate(input);
  const second = playbook.evaluate(input);
  assert.deepEqual(first, second);
});

test('sizing is null without accountRiskUsd and populated when it is provided via context', () => {
  const withoutBudget = playbook.evaluate(stock());
  const withBudget = playbook.evaluate(stock(), { accountRiskUsd: 150 });

  assert.equal(withoutBudget.plan.sizing, null);
  assert.ok(withBudget.plan.sizing.shares >= 0);
});
