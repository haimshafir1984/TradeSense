const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRiskFraming } = require('../src/services/riskFramingService');

test('computes a stop distance from ADR%, floored at the minimum, and a reward/risk ratio from mid-upside', () => {
  const result = computeRiskFraming({
    stock: { price: 10, adr_pct: 6 },
    estimatedUpside: { midPct: 12 }
  });

  assert.equal(result.stopDistancePct, 6);
  assert.equal(result.stopPrice, 9.4);
  assert.equal(result.rewardRiskRatio, 2);
});

test('a low-ADR stock is floored at the minimum stop distance rather than an unrealistically tight stop', () => {
  const result = computeRiskFraming({
    stock: { price: 50, adr_pct: 1.2 },
    estimatedUpside: { midPct: 9 }
  });

  assert.equal(result.stopDistancePct, 3);
  assert.equal(result.stopPrice, 48.5);
  assert.equal(result.rewardRiskRatio, 3);
});

test('missing adr_pct returns nulls instead of fabricating a stop', () => {
  const result = computeRiskFraming({
    stock: { price: 10 },
    estimatedUpside: { midPct: 12 }
  });

  assert.equal(result.stopDistancePct, null);
  assert.equal(result.stopPrice, null);
  assert.equal(result.rewardRiskRatio, null);
});

test('an imputed (fabricated) adr_pct is treated the same as missing', () => {
  const result = computeRiskFraming({
    stock: { price: 10, adr_pct: 6, imputedFields: ['adr_pct'] },
    estimatedUpside: { midPct: 12 }
  });

  assert.equal(result.stopDistancePct, null);
  assert.equal(result.stopPrice, null);
  assert.equal(result.rewardRiskRatio, null);
});

test('missing price returns nulls', () => {
  const result = computeRiskFraming({
    stock: { adr_pct: 6 },
    estimatedUpside: { midPct: 12 }
  });

  assert.equal(result.stopDistancePct, null);
  assert.equal(result.stopPrice, null);
});

test('missing estimatedUpside still yields a stop, but a null reward/risk ratio', () => {
  const result = computeRiskFraming({
    stock: { price: 10, adr_pct: 6 },
    estimatedUpside: undefined
  });

  assert.equal(result.stopDistancePct, 6);
  assert.equal(result.stopPrice, 9.4);
  assert.equal(result.rewardRiskRatio, null);
});
