const test = require('node:test');
const assert = require('node:assert/strict');

function jsonResponse(data) {
  return { ok: true, json: async () => data };
}

test('Finnhub market data results are written to MARKET_DATA_CACHE like FMP/demo results', async () => {
  delete process.env.FMP_API_KEY;
  process.env.FINNHUB_API_KEY = 'test-key';
  process.env.DATA_MODE = 'finnhub';

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes('/quote')) {
      return jsonResponse({ c: 100, pc: 99, h: 101 });
    }
    if (url.includes('/profile2')) {
      return jsonResponse({ name: 'Test', finnhubIndustry: 'Technology', marketCapitalization: 5000 });
    }
    if (url.includes('/metric')) {
      return jsonResponse({ metric: {} });
    }
    if (url.includes('/candle')) {
      return jsonResponse({ s: 'ok', c: Array(60).fill(100), v: Array(60).fill(500000) });
    }
    return jsonResponse({});
  };

  // Capture the "[marketData] Using cached market data..." line, which only fires when
  // MARKET_DATA_CACHE actually has an entry - the bug was that the finnhub branch never wrote one.
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  delete require.cache[require.resolve('../src/services/marketDataService')];
  const { getMarketData } = require('../src/services/marketDataService');

  await getMarketData('NASDAQ');
  await getMarketData('NASDAQ');

  global.fetch = originalFetch;
  console.log = originalLog;
  delete process.env.DATA_MODE;
  delete process.env.FINNHUB_API_KEY;

  assert.ok(
    logs.some((line) => line.includes('Using cached market data')),
    'second call should hit MARKET_DATA_CACHE, but no cache-hit log was found'
  );
});
