const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreStockByStrategy } = require('../src/services/strategies');

const STRATEGY_KEYS = ['micha_stocks', 'mark_minervini', 'ross_cameron', 'swing_momentum', 'small_cap_breakout'];

function stockFixture(overrides = {}) {
  return {
    ticker: 'TEST',
    price: 50,
    daily_change: 6,
    gap_pct: 5,
    volume: 3000000,
    average_volume_30d: 800000,
    market_cap: 1200000000,
    MA50: 45,
    MA200: 40,
    high_52w: 52,
    low_52w: 20,
    volatility: 0.05,
    return_3m: 15,
    revenue_growth_pct: 18,
    adr_pct: 6.2,
    ma50_slope: 0.03,
    price_near_daily_high: 0.98,
    consolidation_score: 0.7,
    imputedFields: [],
    ...overrides
  };
}

// The whole point of the breakdown is that it explains the score. If the parts don't add up to the
// whole, the UI would be showing a reason that isn't the real reason.
test('every strategy reports factor contributions that sum to its own score', () => {
  for (const strategy of STRATEGY_KEYS) {
    const result = scoreStockByStrategy(strategy, stockFixture(), { benchmarkReturn3m: 3 });
    const summed = result.scoreBreakdown.reduce((total, factor) => total + factor.contribution, 0);

    assert.ok(result.scoreBreakdown.length > 0, `${strategy} should report a breakdown`);
    assert.ok(
      Math.abs(summed - result.score) < 0.005,
      `${strategy}: contributions summed to ${summed} but score is ${result.score}`
    );
  }
});

test('breakdown factors are sorted by contribution, strongest reason first', () => {
  for (const strategy of STRATEGY_KEYS) {
    const { scoreBreakdown } = scoreStockByStrategy(strategy, stockFixture(), { benchmarkReturn3m: 3 });
    const contributions = scoreBreakdown.map((factor) => factor.contribution);
    const sorted = [...contributions].sort((left, right) => right - left);

    assert.deepEqual(contributions, sorted, `${strategy} breakdown should be sorted descending`);
  }
});

test('every factor carries a label and a human-readable detail with the observed value', () => {
  for (const strategy of STRATEGY_KEYS) {
    const { scoreBreakdown } = scoreStockByStrategy(strategy, stockFixture(), { benchmarkReturn3m: 3 });

    for (const factor of scoreBreakdown) {
      assert.ok(factor.label && factor.label.length > 0, `${strategy}/${factor.key} needs a label`);
      assert.ok(factor.detail && factor.detail.length > 0, `${strategy}/${factor.key} needs a detail`);
      assert.ok(factor.value >= 0 && factor.value <= 1, `${strategy}/${factor.key} value must be 0-1`);
    }
  }
});

test('swing_momentum reports only the winning sub-setup, not a blend of both', () => {
  // A tight consolidation near highs with moderate volume is a breakout, not an episodic pivot.
  const breakout = scoreStockByStrategy('swing_momentum', stockFixture({ gap_pct: 0, daily_change: 1 }), {
    benchmarkReturn3m: 3
  });
  assert.equal(breakout.swingSetup, 'breakout');
  assert.ok(breakout.scoreBreakdown.some((factor) => factor.key === 'consolidation'));
  assert.ok(!breakout.scoreBreakdown.some((factor) => factor.key === 'move'));

  // A violent gap on huge volume flips it to the episodic-pivot setup.
  const pivot = scoreStockByStrategy(
    'swing_momentum',
    stockFixture({ gap_pct: 18, daily_change: 18, volume: 8000000, consolidation_score: 0 }),
    { benchmarkReturn3m: 3 }
  );
  assert.equal(pivot.swingSetup, 'episodic_pivot');
  assert.ok(pivot.scoreBreakdown.some((factor) => factor.key === 'move'));
  assert.ok(!pivot.scoreBreakdown.some((factor) => factor.key === 'consolidation'));
});

test('gated strategies explain why an ineligible stock scored zero', () => {
  // A mega-cap can never satisfy the small-cap profile.
  const megaCap = scoreStockByStrategy('small_cap_breakout', stockFixture({ market_cap: 900000000000 }), {
    benchmarkReturn3m: 3
  });

  assert.equal(megaCap.score, 0);
  assert.equal(megaCap.eligibility.passed, false);
  assert.match(megaCap.eligibility.reason, /שווי שוק/);
});

test('an eligible stock reports eligibility passed with no rejection reason', () => {
  const eligible = scoreStockByStrategy('small_cap_breakout', stockFixture(), { benchmarkReturn3m: 3 });

  assert.equal(eligible.eligibility.passed, true);
  assert.equal(eligible.eligibility.reason, null);
});
