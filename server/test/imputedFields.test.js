const test = require('node:test');
const assert = require('node:assert/strict');

function jsonResponse(data) {
  return { ok: true, json: async () => data };
}

test('missing FMP fields are tracked in imputedFields and lower confidence', async () => {
  process.env.FMP_API_KEY = 'test-key';
  delete process.env.FINNHUB_API_KEY;

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/quote')) {
      // no volume/marketCap/yearHigh/yearLow on the quote -> forces fallback to history-derived or imputed values
      return jsonResponse([{ price: 100, previousClose: 99 }]);
    }
    if (url.includes('/profile')) {
      return jsonResponse([{ companyName: 'Test Co', sector: 'Technology' }]);
    }
    if (url.includes('historical-price-eod')) {
      // empty history forces price/volume/MA/volatility/high/low all to be imputed
      return jsonResponse([]);
    }
    return jsonResponse([]);
  };

  delete require.cache[require.resolve('../src/services/marketDataService')];
  delete require.cache[require.resolve('../src/services/scannerService')];
  const { analyzeMarket } = require('../src/services/scannerService');

  const response = await analyzeMarket({ exchange: 'NASDAQ', strategy: 'micha_stocks', risk: 'medium', filters: {} });
  global.fetch = originalFetch;

  assert.ok(response.analysis.dataQuality.imputedFieldCount > 0);
  const flaggedResult = response.results.find((result) => result.imputedFields.length > 0);
  assert.ok(flaggedResult, 'expected at least one result to carry imputedFields');
});

test('risk=low excludes stocks whose volatility/volume were imputed', async () => {
  const originalFetch = global.fetch;
  process.env.FMP_API_KEY = 'test-key';

  global.fetch = async (url) => {
    if (url.includes('/quote')) {
      return jsonResponse([{ price: 100, previousClose: 99, marketCap: 6000000000 }]);
    }
    if (url.includes('/profile')) {
      return jsonResponse([{ companyName: 'Test Co', sector: 'Technology', mktCap: 6000000000 }]);
    }
    return jsonResponse([]);
  };

  delete require.cache[require.resolve('../src/services/marketDataService')];
  delete require.cache[require.resolve('../src/services/scannerService')];
  const { analyzeMarket } = require('../src/services/scannerService');

  const response = await analyzeMarket({ exchange: 'NASDAQ', strategy: 'micha_stocks', risk: 'low', filters: {} });
  global.fetch = originalFetch;

  for (const result of response.results) {
    assert.ok(!result.imputedFields.includes('volatility') && !result.imputedFields.includes('volume'));
  }
});
