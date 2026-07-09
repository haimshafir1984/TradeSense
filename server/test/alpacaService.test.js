const test = require('node:test');
const assert = require('node:assert/strict');

function freshAlpacaService() {
  delete require.cache[require.resolve('../src/services/providers/alpacaService')];
  return require('../src/services/providers/alpacaService');
}

function clearAlpacaEnv() {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
}

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

test('isConfigured is false without keys and true once both are set', () => {
  clearAlpacaEnv();
  const alpacaService = freshAlpacaService();
  assert.equal(alpacaService.isConfigured(), false);

  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  assert.equal(alpacaService.isConfigured(), true);

  clearAlpacaEnv();
});

test('getDailyBars splits 450 symbols into 3 chunked requests of <=200 symbols each', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  const alpacaService = freshAlpacaService();

  const originalFetch = global.fetch;
  const requestedSymbolLists = [];

  global.fetch = async (url) => {
    const parsed = new URL(url);
    requestedSymbolLists.push(parsed.searchParams.get('symbols').split(','));
    return jsonResponse({ bars: {}, next_page_token: null });
  };

  const symbols = Array.from({ length: 450 }, (_, index) => `SYM${index}`);
  await alpacaService.getDailyBars({ symbols });

  global.fetch = originalFetch;
  clearAlpacaEnv();

  assert.equal(requestedSymbolLists.length, 3);
  assert.equal(requestedSymbolLists[0].length, 200);
  assert.equal(requestedSymbolLists[1].length, 200);
  assert.equal(requestedSymbolLists[2].length, 50);
});

test('getDailyBars follows next_page_token and merges pages', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  const alpacaService = freshAlpacaService();

  const originalFetch = global.fetch;
  let callCount = 0;

  global.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return jsonResponse({
        bars: { AAA: [{ t: '2026-07-01T00:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }] },
        next_page_token: 'page2'
      });
    }
    return jsonResponse({
      bars: { AAA: [{ t: '2026-07-02T00:00:00Z', o: 1.5, h: 2.5, l: 1, c: 2, v: 200 }] },
      next_page_token: null
    });
  };

  const bars = await alpacaService.getDailyBars({ symbols: ['AAA'] });

  global.fetch = originalFetch;
  clearAlpacaEnv();

  assert.equal(callCount, 2);
  const aaaBars = bars.get('AAA');
  assert.equal(aaaBars.length, 2);
  assert.equal(aaaBars[0].t, '2026-07-01T00:00:00Z');
  assert.equal(aaaBars[1].t, '2026-07-02T00:00:00Z');
});

test('an HTTP error response returns an empty Map instead of throwing', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  const alpacaService = freshAlpacaService();

  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse(null, false, 403);

  const bars = await alpacaService.getDailyBars({ symbols: ['AAA'] });

  global.fetch = originalFetch;
  clearAlpacaEnv();

  assert.equal(bars.size, 0);
});

test('getActiveAssets returns an empty array without throwing on HTTP error', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  const alpacaService = freshAlpacaService();

  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse(null, false, 500);

  const assets = await alpacaService.getActiveAssets({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  clearAlpacaEnv();

  assert.deepEqual(assets, []);
});

test('getActiveAssets targets the paper-api host for paper keys (PK prefix) and the live host otherwise', async () => {
  const originalFetch = global.fetch;
  const requestedHosts = [];
  global.fetch = async (url) => {
    requestedHosts.push(new URL(url).host);
    return jsonResponse([]);
  };

  process.env.ALPACA_API_KEY_ID = 'PKtestpaper';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  delete process.env.ALPACA_TRADING_BASE_URL;
  let alpacaService = freshAlpacaService();
  await alpacaService.getActiveAssets({ exchange: 'NASDAQ' });

  process.env.ALPACA_API_KEY_ID = 'AKtestlive';
  alpacaService = freshAlpacaService();
  await alpacaService.getActiveAssets({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  clearAlpacaEnv();

  assert.deepEqual(requestedHosts, ['paper-api.alpaca.markets', 'api.alpaca.markets']);
});

test('getActiveAssets filters to tradable, exact-exchange, plain-symbol equities', async () => {
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  const alpacaService = freshAlpacaService();

  const originalFetch = global.fetch;
  global.fetch = async () =>
    jsonResponse([
      { symbol: 'AAPL', name: 'Apple Inc', exchange: 'NASDAQ', tradable: true },
      { symbol: 'MSFT', name: 'Microsoft', exchange: 'NASDAQ', tradable: false }, // not tradable
      { symbol: 'IBM', name: 'IBM', exchange: 'NYSE', tradable: true }, // wrong exchange for this request
      { symbol: 'BRK.B', name: 'Berkshire', exchange: 'NASDAQ', tradable: true }, // has a dot
      { symbol: 'PFD/WS', name: 'Preferred Warrant', exchange: 'NASDAQ', tradable: true } // has a slash
    ]);

  const assets = await alpacaService.getActiveAssets({ exchange: 'NASDAQ' });

  global.fetch = originalFetch;
  clearAlpacaEnv();

  assert.equal(assets.length, 1);
  assert.equal(assets[0].symbol, 'AAPL');
});
