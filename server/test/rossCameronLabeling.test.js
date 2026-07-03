const test = require('node:test');
const assert = require('node:assert/strict');
const { STRATEGY_LABELS } = require('../src/services/strategies');
const { enrichExplanation } = require('../src/services/explanationService');

test('ross_cameron strategy is labeled as EOD short-term momentum, not live day trading', () => {
  assert.ok(!STRATEGY_LABELS.ross_cameron.includes('מסחר יומי'));
  assert.ok(STRATEGY_LABELS.ross_cameron.includes('סוף יום'));
});

test('fit horizon explanation discloses EOD data for ross_cameron', () => {
  const explanation = enrichExplanation({
    stock: { volatility: 0.02, average_volume_30d: 1000000, volume: 1000000, high_52w: 100, price: 90 },
    strategy: 'ross_cameron',
    deterministicExplanation: 'x',
    dataQuality: { level: 'high' },
    confluence: {},
    riskOverlay: { factors: [] },
    expertSupport: {}
  });

  assert.ok(explanation.fitHorizon.includes('סוף יום'));
});
