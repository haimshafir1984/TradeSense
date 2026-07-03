const test = require('node:test');
const assert = require('node:assert/strict');
const { assessOpportunity } = require('../src/services/opportunityScoringService');

test('opportunityRank is not affected by confluence/expertSupport/dataQuality (no double counting)', () => {
  const baseArgs = {
    stock: { score: 0.7, market_cap: 5000000000, volatility: 0.03 },
    strategy: 'micha_stocks',
    confidenceScore: 80,
    riskOverlay: { score: 1 },
    marketRegime: { regime: 'bullish', strategyFit: { level: 'high' } }
  };

  const withoutExtras = assessOpportunity(baseArgs);
  const withExtras = assessOpportunity({
    ...baseArgs,
    confluence: { level: 'high' },
    expertSupport: { supportCount: 3 },
    dataQuality: { level: 'low' }
  });

  assert.equal(withoutExtras.opportunityRank, withExtras.opportunityRank);
});

test('riskOverlay is the only overlay that still moves opportunityRank', () => {
  const lowRisk = assessOpportunity({
    stock: { score: 0.6, market_cap: 5000000000, volatility: 0.03 },
    strategy: 'micha_stocks',
    confidenceScore: 70,
    riskOverlay: { score: 0 }
  });
  const highRisk = assessOpportunity({
    stock: { score: 0.6, market_cap: 5000000000, volatility: 0.03 },
    strategy: 'micha_stocks',
    confidenceScore: 70,
    riskOverlay: { score: 5 }
  });

  assert.ok(highRisk.opportunityRank < lowRisk.opportunityRank);
});
