const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeAccountRiskUsd,
  dailyLossCapUsd,
  hasReachedDailyLossCap,
  canOpenNewPosition
} = require('../src/risk/positionSizing');

test('computeAccountRiskUsd returns null for hypothesis/backtested playbooks - not tradeable at all', () => {
  const hypothesis = computeAccountRiskUsd({ accountEquityUsd: 10000, riskTierKey: 'balanced', playbookStatus: 'hypothesis' });
  const backtested = computeAccountRiskUsd({ accountEquityUsd: 10000, riskTierKey: 'balanced', playbookStatus: 'backtested' });

  assert.equal(hypothesis, null);
  assert.equal(backtested, null);
});

test('computeAccountRiskUsd halves the tier\'s risk-per-trade for a provisional playbook', () => {
  // balanced riskPerTradePct = 1.0% of 10000 = 100, halved to 50 for provisional.
  const provisional = computeAccountRiskUsd({ accountEquityUsd: 10000, riskTierKey: 'balanced', playbookStatus: 'provisional' });
  const active = computeAccountRiskUsd({ accountEquityUsd: 10000, riskTierKey: 'balanced', playbookStatus: 'active' });

  assert.equal(provisional, 50);
  assert.equal(active, 100);
});

test('computeAccountRiskUsd returns null for an unknown tier or missing/invalid account equity', () => {
  assert.equal(computeAccountRiskUsd({ accountEquityUsd: 10000, riskTierKey: 'yolo', playbookStatus: 'active' }), null);
  assert.equal(computeAccountRiskUsd({ accountEquityUsd: null, riskTierKey: 'balanced', playbookStatus: 'active' }), null);
  assert.equal(computeAccountRiskUsd({ accountEquityUsd: 0, riskTierKey: 'balanced', playbookStatus: 'active' }), null);
  assert.equal(computeAccountRiskUsd({ accountEquityUsd: -500, riskTierKey: 'balanced', playbookStatus: 'active' }), null);
});

test('dailyLossCapUsd is null for the conservative tier (no cap) and computed for balanced/aggressive', () => {
  assert.equal(dailyLossCapUsd({ accountEquityUsd: 10000, riskTierKey: 'conservative' }), null);
  assert.equal(dailyLossCapUsd({ accountEquityUsd: 10000, riskTierKey: 'balanced' }), 300); // 3%
  assert.equal(dailyLossCapUsd({ accountEquityUsd: 10000, riskTierKey: 'aggressive' }), 200); // 2%
});

test('hasReachedDailyLossCap is true once realized loss meets or exceeds the cap', () => {
  const under = hasReachedDailyLossCap({ accountEquityUsd: 10000, riskTierKey: 'aggressive', realizedLossUsdToday: 150 });
  const atCap = hasReachedDailyLossCap({ accountEquityUsd: 10000, riskTierKey: 'aggressive', realizedLossUsdToday: 200 });
  const over = hasReachedDailyLossCap({ accountEquityUsd: 10000, riskTierKey: 'aggressive', realizedLossUsdToday: 250 });

  assert.equal(under, false);
  assert.equal(atCap, true);
  assert.equal(over, true);
});

test('hasReachedDailyLossCap never blocks a tier with no cap', () => {
  const result = hasReachedDailyLossCap({ accountEquityUsd: 10000, riskTierKey: 'conservative', realizedLossUsdToday: 999999 });
  assert.equal(result, false);
});

test('canOpenNewPosition respects each tier\'s concurrency limit', () => {
  assert.equal(canOpenNewPosition({ riskTierKey: 'conservative', openPositionsCount: 2 }), true);
  assert.equal(canOpenNewPosition({ riskTierKey: 'conservative', openPositionsCount: 3 }), false);
  assert.equal(canOpenNewPosition({ riskTierKey: 'balanced', openPositionsCount: 4 }), true);
  assert.equal(canOpenNewPosition({ riskTierKey: 'balanced', openPositionsCount: 5 }), false);
});

test('canOpenNewPosition returns false for an unknown tier instead of throwing', () => {
  assert.equal(canOpenNewPosition({ riskTierKey: 'yolo', openPositionsCount: 0 }), false);
});
