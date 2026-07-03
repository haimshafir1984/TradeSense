const test = require('node:test');
const assert = require('node:assert/strict');

function jsonResponse(data) {
  return { ok: true, json: async () => data };
}

test('a scan where every candidate scores weakly returns no results with noQualitySetups flagged', async () => {
  process.env.FMP_API_KEY = 'test-key';
  delete process.env.FINNHUB_API_KEY;

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/quote')) {
      // Flat price, no daily change, no volume above average, far below MA50/MA200 and 52w high
      // -> every strategy scores this near zero for every stock in the universe.
      return jsonResponse([{ price: 50, previousClose: 50, changesPercentage: 0, marketCap: 500000000, yearHigh: 200, yearLow: 40 }]);
    }
    if (url.includes('/profile')) {
      return jsonResponse([{ companyName: 'Weak Co', sector: 'Technology', mktCap: 500000000 }]);
    }
    if (url.includes('historical-price-eod')) {
      const closes = Array.from({ length: 210 }, () => 150);
      return jsonResponse(closes.map((close) => ({ close, high: close, low: close, volume: 100 })));
    }
    return jsonResponse([]);
  };

  delete require.cache[require.resolve('../src/services/marketDataService')];
  delete require.cache[require.resolve('../src/services/scannerService')];
  const { analyzeMarket } = require('../src/services/scannerService');

  const response = await analyzeMarket({ exchange: 'NASDAQ', strategy: 'micha_stocks', risk: 'medium', filters: {} });
  global.fetch = originalFetch;

  assert.equal(response.results.length, 0);
  assert.equal(response.meta.noQualitySetups, true);
  assert.equal(response.meta.returnedCount, 0);
});
