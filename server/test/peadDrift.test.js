const test = require('node:test');
const assert = require('node:assert/strict');

const playbook = require('../src/playbooks/peadDrift');

function stock(overrides = {}) {
  return {
    symbol: 'PEAD',
    price: 110,
    atr14: 4,
    dailyChangePct: 8,
    high52w: 120,
    rvol: 3,
    catalyst: {
      kind: 'earnings_surprise',
      earningsSurprisePct: 15,
      daysSinceEarnings: 1,
      newsCount48h: 3,
      premarketGapPct: 7,
      confidence: 'high'
    },
    ...overrides
  };
}

test('registers with the expected key, hypothesis status, and evidence sources', () => {
  assert.equal(playbook.key, 'pead_drift');
  assert.equal(playbook.status, 'hypothesis');
  assert.ok(playbook.evidence.sources.some((source) => source.includes('Ball')));
  assert.equal(playbook.evidence.strength, 'strong');
});

test('a fresh large earnings surprise with a strong reaction day is eligible with a valid plan', () => {
  const result = playbook.evaluate(stock());

  assert.equal(result.eligible, true);
  assert.equal(result.plan.valid, true);
  assert.equal(result.plan.stop.basis, 'atr14 × 2.5');
  assert.equal(result.plan.target.rMultiple, 3);
  assert.ok(result.conviction > 0 && result.conviction <= 1);
});

test('rejects when there is no earnings-surprise catalyst at all', () => {
  const noEarnings = playbook.evaluate(stock({ catalyst: { kind: 'news_spike', confidence: 'medium' } }));
  const noCatalyst = playbook.evaluate(stock({ catalyst: null }));

  for (const result of [noEarnings, noCatalyst]) {
    assert.equal(result.eligible, false);
    assert.match(result.reason, /הפתעת רווחים/);
    assert.equal(result.plan, null);
  }
});

test('rejects a surprise reported outside the recent (0-3 trading day) window', () => {
  const result = playbook.evaluate(stock({ catalyst: { ...stock().catalyst, daysSinceEarnings: 10 } }));

  assert.equal(result.eligible, false);
  assert.match(result.reason, /ימי מסחר/);
});

test('rejects a surprise below the 5% trigger, independently of the other gates', () => {
  const result = playbook.evaluate(stock({ catalyst: { ...stock().catalyst, earningsSurprisePct: 2 } }));

  assert.equal(result.eligible, false);
  assert.match(result.reason, /הפתעת רווחים/);
});

test('rejects a weak reaction day even with a huge surprise, independently of the other gates', () => {
  const result = playbook.evaluate(stock({ dailyChangePct: 0.5 }));

  assert.equal(result.eligible, false);
  assert.match(result.reason, /תגובה לדוח/);
});

test('missing atr14 invalidates the plan and the candidate is rejected, not shown with a broken plan', () => {
  const result = playbook.evaluate(stock({ atr14: null }));

  assert.equal(result.eligible, false);
  assert.equal(result.plan, null);
  assert.match(result.reason, /atr14/);
});

test('conviction factors gracefully omit rvol/highProximity when those fields are unavailable', () => {
  const result = playbook.evaluate(stock({ rvol: null, high52w: null }));

  assert.equal(result.eligible, true);
  assert.ok(!result.factors.some((factor) => factor.key === 'volumeOnReaction'));
  assert.ok(!result.factors.some((factor) => factor.key === 'highProximity'));
  assert.ok(result.factors.length >= 2); // surpriseSize + dayReaction always present
});

test('evaluate is deterministic given the same stock object (no hidden clock/global state)', () => {
  const input = stock();
  const first = playbook.evaluate(input);
  const second = playbook.evaluate(input);
  assert.deepEqual(first, second);
});

test('sizing is null without accountRiskUsd and populated when it is provided via context', () => {
  const withoutBudget = playbook.evaluate(stock());
  const withBudget = playbook.evaluate(stock(), { accountRiskUsd: 300 });

  assert.equal(withoutBudget.plan.sizing, null);
  assert.ok(withBudget.plan.sizing.shares >= 0);
});
