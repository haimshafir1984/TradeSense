const test = require('node:test');
const assert = require('node:assert/strict');

const { getRiskTier, listRiskTiers, isPlaybookAllowed, isMarketCapInRange } = require('../src/risk/riskTiers');

test('all three tiers exist with the playbooks assigned in §5.5', () => {
  assert.deepEqual(getRiskTier('conservative').playbooks, ['pead_drift', 'short_term_reversal']);
  assert.deepEqual(getRiskTier('balanced').playbooks, ['pead_drift', 'gap_continuation', 'short_term_reversal']);
  assert.deepEqual(getRiskTier('aggressive').playbooks, ['opening_range_breakout', 'gap_continuation']);
});

test('an unknown tier key returns null, not a throw', () => {
  assert.equal(getRiskTier('yolo'), null);
});

test('listRiskTiers returns all three tiers with their key attached', () => {
  const tiers = listRiskTiers();
  assert.equal(tiers.length, 3);
  assert.ok(tiers.every((tier) => typeof tier.key === 'string'));
});

test('isPlaybookAllowed reflects each tier\'s playbook list', () => {
  assert.equal(isPlaybookAllowed('conservative', 'pead_drift'), true);
  assert.equal(isPlaybookAllowed('conservative', 'opening_range_breakout'), false);
  assert.equal(isPlaybookAllowed('aggressive', 'opening_range_breakout'), true);
  assert.equal(isPlaybookAllowed('unknown_tier', 'pead_drift'), false);
});

test('the aggressive tier carries a mandatory daily loss cap', () => {
  assert.equal(getRiskTier('aggressive').dailyLossCapPct, 2);
});

test('the conservative tier has no daily loss cap (weeks-long horizon)', () => {
  assert.equal(getRiskTier('conservative').dailyLossCapPct, null);
});

test('isMarketCapInRange enforces each tier\'s bounds, including an open-ended max', () => {
  assert.equal(isMarketCapInRange('conservative', 15000000000), true); // > 10B, no max
  assert.equal(isMarketCapInRange('conservative', 5000000000), false); // below 10B floor
  assert.equal(isMarketCapInRange('balanced', 50000000000), true); // within 2B-200B
  assert.equal(isMarketCapInRange('balanced', 500000000000), false); // above 200B ceiling
  assert.equal(isMarketCapInRange('aggressive', 1000000000), true); // within 300M-10B
  assert.equal(isMarketCapInRange('aggressive', 200000000), false); // below 300M floor
});

test('isMarketCapInRange returns false for a non-finite market cap instead of throwing', () => {
  assert.equal(isMarketCapInRange('balanced', null), false);
  assert.equal(isMarketCapInRange('balanced', NaN), false);
});
