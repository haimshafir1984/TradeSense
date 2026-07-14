// Integration tests for docs/SPEC_PROVIDER_REBALANCE.md - verifies the Alpaca+Nasdaq+Finnhub
// provider chain actually replaces FMP end-to-end (not just that each adapter works in isolation,
// which nasdaqService.test.js/finnhubService.test.js already cover).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function scratchUniverseStorePath() {
  return path.join(os.tmpdir(), `universeCache-providerRebalance-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function jsonResponse(data, ok = true) {
  // nasdaqService reads the body via text() + JSON.parse (so it can detect a 200 + non-JSON
  // block-page from Akamai) - text() has to be present alongside json() for every mock response
  // that might be hit by a Nasdaq call.
  return { ok, json: async () => data, text: async () => JSON.stringify(data) };
}

function nasdaqScreenerResponse(rows) {
  return jsonResponse({ data: { totalrecords: rows.length, table: { rows } } });
}

function nasdaqRow(symbol, { price = '25.00', marketCap = '2,000,000,000', pctchange = '1.0%' } = {}) {
  return { symbol, name: `${symbol} Inc Common Stock`, lastsale: price, marketCap, pctchange };
}

function bars({ days = 60, basePrice = 25 } = {}) {
  const result = [];
  for (let i = 0; i < days; i += 1) {
    result.push({ t: `2026-0${(i % 9) + 1}-01T00:00:00Z`, o: basePrice, h: basePrice + 0.5, l: basePrice - 0.5, c: basePrice, v: 500000 });
  }
  return result;
}

function freshServices() {
  const scratchPath = scratchUniverseStorePath();
  process.env.UNIVERSE_STORE_FILE_PATH = scratchPath;

  delete require.cache[require.resolve('../src/services/providers/alpacaService')];
  delete require.cache[require.resolve('../src/services/providers/nasdaqService')];
  delete require.cache[require.resolve('../src/services/providers/finnhubService')];
  delete require.cache[require.resolve('../src/services/universeStore')];
  delete require.cache[require.resolve('../src/services/universeBuilderService')];
  delete require.cache[require.resolve('../src/services/marketDataService')];
  delete require.cache[require.resolve('../src/services/funnelScanService')];
  delete require.cache[require.resolve('../src/services/watchlistScoring')];

  return {
    scratchPath,
    alpacaService: require('../src/services/providers/alpacaService'),
    marketDataService: require('../src/services/marketDataService'),
    funnelScanService: require('../src/services/funnelScanService'),
    watchlistScoring: require('../src/services/watchlistScoring')
  };
}

function clearProviderEnv(scratchPath) {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FINNHUB_API_KEY;
  delete process.env.FMP_API_KEY;
  if (scratchPath) {
    fs.rmSync(scratchPath, { force: true });
    delete process.env.UNIVERSE_STORE_FILE_PATH;
  }
}

test('getMarketData uses the Alpaca+Nasdaq path and never calls FMP when Alpaca is configured and Nasdaq succeeds', async () => {
  clearProviderEnv();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key'; // present but must never be hit

  const { alpacaService, marketDataService, scratchPath } = freshServices();

  const originalFetch = global.fetch;
  let fmpWasCalled = false;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('financialmodelingprep.com')) {
      fmpWasCalled = true;
      return jsonResponse([]);
    }
    if (urlStr.includes('api.nasdaq.com')) {
      return nasdaqScreenerResponse([nasdaqRow('ALPHA'), nasdaqRow('BETA', { marketCap: '1,000,000,000' })]);
    }
    return jsonResponse([]);
  };

  alpacaService.getDailyBars = async ({ symbols }) => {
    const map = new Map();
    for (const symbol of symbols) {
      map.set(symbol, bars());
    }
    return map;
  };

  const result = await marketDataService.getMarketData('NASDAQ');

  global.fetch = originalFetch;
  clearProviderEnv(scratchPath);

  assert.equal(fmpWasCalled, false);
  assert.equal(result.source, 'alpaca+nasdaq');
  assert.ok(result.stocks.length >= 2);
  assert.ok(result.stocks.every((stock) => stock.data_source === 'alpaca+nasdaq'));
});

test('getMarketData falls back to the FMP screener when the Nasdaq screener fails, even with Alpaca configured', async () => {
  clearProviderEnv();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key';

  const { alpacaService, marketDataService, scratchPath } = freshServices();

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('api.nasdaq.com')) {
      return { ok: false, status: 500 };
    }
    if (urlStr.includes('/company-screener')) {
      return jsonResponse([{ symbol: 'GAMMA', companyName: 'Gamma Inc', sector: 'Technology' }]);
    }
    if (urlStr.includes('/quote')) {
      return jsonResponse([{ price: 50, previousClose: 49, dayHigh: 51, volume: 1000000, marketCap: 2000000000, yearHigh: 55, yearLow: 40, changesPercentage: 1 }]);
    }
    if (urlStr.includes('/profile')) {
      return jsonResponse([{ companyName: 'Gamma Inc', sector: 'Technology', mktCap: 2000000000 }]);
    }
    if (urlStr.includes('historical-price-eod')) {
      const historical = Array.from({ length: 40 }, (_, i) => ({ close: 50 - i * 0.1, high: 51, low: 49, volume: 1000000 }));
      return jsonResponse(historical);
    }
    return jsonResponse([]);
  };

  alpacaService.getDailyBars = async () => new Map();

  const result = await marketDataService.getMarketData('NASDAQ');

  global.fetch = originalFetch;
  clearProviderEnv(scratchPath);

  assert.equal(result.source, 'fmp');
  assert.ok(result.stocks.some((stock) => stock.ticker === 'GAMMA'));
});

test('getStockSnapshot uses Alpaca bars + a best-effort Finnhub profile when Alpaca is configured', async () => {
  clearProviderEnv();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FINNHUB_API_KEY = 'finnhub-key';
  process.env.FMP_API_KEY = 'fmp-key';

  const { alpacaService, marketDataService, scratchPath } = freshServices();

  const originalFetch = global.fetch;
  let fmpWasCalled = false;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('financialmodelingprep.com')) {
      fmpWasCalled = true;
      return jsonResponse([]);
    }
    if (urlStr.includes('/stock/profile2')) {
      return jsonResponse({ name: 'Apple Inc', finnhubIndustry: 'Technology', marketCapitalization: 3000000 });
    }
    return jsonResponse([]);
  };

  alpacaService.getDailyBars = async () => new Map([['AAPL', bars({ basePrice: 200 })]]);

  const snapshot = await marketDataService.getStockSnapshot('AAPL');

  global.fetch = originalFetch;
  clearProviderEnv(scratchPath);

  assert.equal(fmpWasCalled, false);
  assert.equal(snapshot.ticker, 'AAPL');
  assert.equal(snapshot.companyName, 'Apple Inc');
  assert.equal(snapshot.market_cap, 3000000 * 1000000);
  assert.equal(snapshot.data_source, 'alpaca+nasdaq');
});

test('resolveEarningsSoon uses Finnhub when configured and never falls through to FMP', async () => {
  clearProviderEnv();
  process.env.FINNHUB_API_KEY = 'finnhub-key';
  process.env.FMP_API_KEY = 'fmp-key';

  const { watchlistScoring, scratchPath } = freshServices();

  const originalFetch = global.fetch;
  let fmpWasCalled = false;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('financialmodelingprep.com')) {
      fmpWasCalled = true;
      return jsonResponse([]);
    }
    if (urlStr.includes('/calendar/earnings')) {
      return jsonResponse({ earningsCalendar: [{ symbol: 'AAPL' }] });
    }
    return jsonResponse([]);
  };

  const result = await watchlistScoring.resolveEarningsSoon('AAPL', process.env.FMP_API_KEY);

  global.fetch = originalFetch;
  clearProviderEnv(scratchPath);

  assert.equal(result, true);
  assert.equal(fmpWasCalled, false);
});

test('TASE requests bypass the Alpaca+Nasdaq path entirely and use the existing FMP path unchanged', async () => {
  clearProviderEnv();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FMP_API_KEY = 'fmp-key';

  const { marketDataService, scratchPath } = freshServices();

  const originalFetch = global.fetch;
  let nasdaqWasCalled = false;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('api.nasdaq.com')) {
      nasdaqWasCalled = true;
      return jsonResponse({ data: { totalrecords: 0, table: { rows: [] } } });
    }
    if (urlStr.includes('/quote')) {
      return jsonResponse([{ price: 50, previousClose: 49, dayHigh: 51, volume: 1000000, marketCap: 2000000000, yearHigh: 55, yearLow: 40, changesPercentage: 1 }]);
    }
    if (urlStr.includes('/profile')) {
      return jsonResponse([{ companyName: 'TASE Co', sector: 'Finance', mktCap: 2000000000 }]);
    }
    if (urlStr.includes('historical-price-eod')) {
      const historical = Array.from({ length: 40 }, (_, i) => ({ close: 50 - i * 0.1, high: 51, low: 49, volume: 1000000 }));
      return jsonResponse(historical);
    }
    return jsonResponse([]);
  };

  const result = await marketDataService.getMarketData('TASE');

  global.fetch = originalFetch;
  clearProviderEnv(scratchPath);

  assert.equal(nasdaqWasCalled, false);
  assert.equal(result.source, 'fmp');
});

test('a stale (24-72h old) universe entry is still served immediately, flagged isStale: true', async () => {
  clearProviderEnv();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';

  const { alpacaService, marketDataService, scratchPath } = freshServices();
  const universeStore = require('../src/services/universeStore');

  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await universeStore.writeUniverseCache({
    NASDAQ: {
      generatedAt: fortyEightHoursAgo,
      source: 'nasdaq',
      rows: [{ symbol: 'STALE', companyName: 'Stale Inc', sector: 'Technology', marketCap: 2000000000, price: 20, avgDollarVolume: 5000000 }]
    }
  });

  // The background refresh this triggers (fire-and-forget) may itself call fetch - not asserted
  // on here since its timing relative to this test's own assertions isn't deterministic. What
  // matters is that the *stale* data is served immediately rather than blocking on that refresh.
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse([]);

  alpacaService.getDailyBars = async () => new Map([['STALE', bars()]]);

  const result = await marketDataService.getMarketData('NASDAQ');

  global.fetch = originalFetch;
  clearProviderEnv(scratchPath);

  assert.equal(result.isStale, true);
  assert.ok(result.stocks.some((stock) => stock.ticker === 'STALE'));
});
