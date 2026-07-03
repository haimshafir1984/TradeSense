const test = require('node:test');
const assert = require('node:assert/strict');

test('TASE tickers are requested from FMP with a .TA suffix', async () => {
  process.env.FMP_API_KEY = 'test-key';
  delete process.env.FINNHUB_API_KEY;

  const requestedUrls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    requestedUrls.push(url);
    if (url.includes('historical-price-eod')) {
      return jsonResponse(Array.from({ length: 40 }, (_, i) => ({ close: 100 - i, high: 101, low: 99, volume: 500000 })));
    }
    return jsonResponse([{ price: 100, previousClose: 99, dayHigh: 101, volume: 500000, marketCap: 1000000000 }]);
  };

  delete require.cache[require.resolve('../src/services/marketDataService')];
  const { getMarketData } = require('../src/services/marketDataService');

  await getMarketData('TASE');
  global.fetch = originalFetch;

  const teva = requestedUrls.find((url) => url.includes('/quote') && url.includes('symbol=TEVA'));
  assert.ok(teva, 'expected a quote request containing symbol=TEVA');
  assert.ok(teva.includes('symbol=TEVA.TA'), `expected .TA suffix in request, got: ${teva}`);
});

function jsonResponse(data) {
  return {
    ok: true,
    json: async () => data
  };
}
