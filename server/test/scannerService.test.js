const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeMarket } = require('../src/services/scannerService');

test('analyzeMarket runs end-to-end on demo data without institutional/insider filters', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const response = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'micha_stocks',
    risk: 'medium',
    filters: {}
  });

  assert.ok(Array.isArray(response.results));
  assert.ok(response.results.length > 0);
  for (const result of response.results) {
    assert.equal(result.institutional_inflow, undefined);
    assert.equal(result.insider_transactions, undefined);
  }
});

test('applyFilters no longer recognizes institutionalBuying/insiderBuying flags', async () => {
  delete process.env.FMP_API_KEY;
  delete process.env.FINNHUB_API_KEY;

  const withFlags = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'micha_stocks',
    risk: 'medium',
    filters: { institutionalBuying: true, insiderBuying: true }
  });
  const withoutFlags = await analyzeMarket({
    exchange: 'NASDAQ',
    strategy: 'micha_stocks',
    risk: 'medium',
    filters: {}
  });

  assert.equal(withFlags.meta.analyzedCount, withoutFlags.meta.analyzedCount);
});
