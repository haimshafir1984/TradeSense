const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeMarket } = require('../src/services/scannerService');

test('opportunity is exposed as a relative rank, not a labeled probability', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const response = await analyzeMarket({ exchange: 'NASDAQ', strategy: 'micha_stocks', risk: 'medium', filters: {} });

  for (const result of response.results) {
    assert.equal(result.successProbability, undefined);
    assert.ok(Number.isFinite(result.opportunityRank));
    assert.equal(result.opportunity.successProbability, undefined);
    assert.ok(Number.isFinite(result.opportunity.opportunityRank));
  }
});
