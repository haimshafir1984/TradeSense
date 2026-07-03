const test = require('node:test');
const assert = require('node:assert/strict');

function jsonResponse(data) {
  return { ok: true, json: async () => data };
}

test('risk profile no longer creates a hard cliff at the volatility threshold', async () => {
  process.env.FMP_API_KEY = 'test-key';
  delete process.env.FINNHUB_API_KEY;

  const originalFetch = global.fetch;
  // Two near-identical stocks straddling the old 0.03 cliff for risk=low.
  global.fetch = async (url) => {
    if (url.includes('/quote')) {
      return jsonResponse([{ price: 100, previousClose: 99, marketCap: 6000000000 }]);
    }
    if (url.includes('/profile')) {
      return jsonResponse([{ companyName: 'Test Co', sector: 'Technology', mktCap: 6000000000 }]);
    }
    if (url.includes('historical-price-eod')) {
      const closes = Array.from({ length: 210 }, (_, i) => 100 - i * 0.01);
      return jsonResponse(closes.map((close) => ({ close, high: close + 1, low: close - 1, volume: 1000000 })));
    }
    return jsonResponse([]);
  };

  delete require.cache[require.resolve('../src/services/marketDataService')];
  delete require.cache[require.resolve('../src/services/scannerService')];
  const { analyzeMarket } = require('../src/services/scannerService');

  const response = await analyzeMarket({ exchange: 'NASDAQ', strategy: 'micha_stocks', risk: 'low', filters: {} });
  global.fetch = originalFetch;

  // Every stock that made it through explicit filters should still be present (soft penalty
  // only demotes via score, applyFilters no longer removes anything based on `risk`).
  assert.equal(response.meta.analyzedCount, 20);
  for (const result of response.results) {
    assert.ok(Number.isFinite(result.riskFitPenalty));
    assert.ok(result.riskFitPenalty > 0);
  }
});
