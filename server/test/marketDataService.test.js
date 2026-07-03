const test = require('node:test');
const assert = require('node:assert/strict');

test('dividend_yield is computed as lastDiv/price percentage, not raw dollar amount', async () => {
  process.env.FMP_API_KEY = 'test-key';
  delete process.env.FINNHUB_API_KEY;

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/quote')) {
      return jsonResponse([{ price: 50, previousClose: 49, dayHigh: 51, volume: 1000000, marketCap: 5000000000, yearHigh: 60, yearLow: 40, changesPercentage: 1.2 }]);
    }
    if (url.includes('/profile')) {
      return jsonResponse([{ companyName: 'Test Co', sector: 'Technology', lastDiv: 2, mktCap: 5000000000 }]);
    }
    if (url.includes('historical-price-eod')) {
      const historical = Array.from({ length: 40 }, (_, i) => ({ close: 50 - i * 0.1, high: 51, low: 49, volume: 1000000 }));
      return jsonResponse(historical);
    }
    return jsonResponse([]);
  };

  delete require.cache[require.resolve('../src/services/marketDataService')];
  const { getMarketData } = require('../src/services/marketDataService');

  const { stocks } = await getMarketData('NASDAQ');
  global.fetch = originalFetch;

  const stock = stocks.find((item) => item.ticker === 'AAPL');
  assert.ok(stock, 'expected AAPL in demo NASDAQ universe');
  assert.equal(stock.dividend_yield, 4);
});

function jsonResponse(data) {
  return {
    ok: true,
    json: async () => data
  };
}
