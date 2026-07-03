const test = require('node:test');
const assert = require('node:assert/strict');

function jsonResponse(data) {
  return { ok: true, json: async () => data };
}

function stockResponses(url) {
  if (url.includes('/quote')) {
    return jsonResponse([{ price: 50, previousClose: 49, marketCap: 2000000000 }]);
  }
  if (url.includes('/profile')) {
    return jsonResponse([{ companyName: 'Screened Co', sector: 'Technology', mktCap: 2000000000 }]);
  }
  if (url.includes('historical-price-eod')) {
    const closes = Array.from({ length: 210 }, (_, i) => 50 - i * 0.01);
    return jsonResponse(closes.map((close) => ({ close, high: close + 1, low: close - 1, volume: 300000 })));
  }
  return jsonResponse([]);
}

test('uses the FMP screener universe when it returns usable candidates', async () => {
  process.env.FMP_API_KEY = 'test-key';
  delete process.env.FINNHUB_API_KEY;

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/company-screener')) {
      return jsonResponse(
        Array.from({ length: 15 }, (_, i) => ({
          symbol: `SCR${i}`,
          companyName: `Screened Co ${i}`,
          sector: 'Technology'
        }))
      );
    }
    return stockResponses(url);
  };

  delete require.cache[require.resolve('../src/services/marketDataService')];
  const { getMarketData } = require('../src/services/marketDataService');

  const { stocks } = await getMarketData('NASDAQ');
  global.fetch = originalFetch;

  const tickers = stocks.map((stock) => stock.ticker);
  assert.ok(tickers.every((ticker) => ticker.startsWith('SCR')), `expected screener tickers, got: ${tickers.join(',')}`);
});

test('falls back to the static universe when the screener returns nothing usable', async () => {
  process.env.FMP_API_KEY = 'test-key';
  delete process.env.FINNHUB_API_KEY;

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/company-screener')) {
      return jsonResponse([]);
    }
    return stockResponses(url);
  };

  delete require.cache[require.resolve('../src/services/marketDataService')];
  const { getMarketData } = require('../src/services/marketDataService');

  const { stocks } = await getMarketData('NASDAQ');
  global.fetch = originalFetch;

  const tickers = stocks.map((stock) => stock.ticker);
  assert.ok(tickers.includes('AAPL'), `expected static universe fallback (AAPL), got: ${tickers.join(',')}`);
});
