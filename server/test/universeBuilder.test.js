const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function scratchFile() {
  return path.join(os.tmpdir(), `universeCache-builder-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function freshServices(scratchPath) {
  process.env.UNIVERSE_STORE_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/services/providers/alpacaService')];
  delete require.cache[require.resolve('../src/services/providers/nasdaqService')];
  delete require.cache[require.resolve('../src/services/providers/finnhubService')];
  delete require.cache[require.resolve('../src/services/marketDataService')];
  delete require.cache[require.resolve('../src/services/universeStore')];
  delete require.cache[require.resolve('../src/services/universeBuilderService')];

  return {
    alpacaService: require('../src/services/providers/alpacaService'),
    nasdaqService: require('../src/services/providers/nasdaqService'),
    finnhubService: require('../src/services/providers/finnhubService'),
    universeStore: require('../src/services/universeStore'),
    universeBuilderService: require('../src/services/universeBuilderService')
  };
}

function clearEnv() {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.FINNHUB_API_KEY;
  delete process.env.FMP_API_KEY;
  delete process.env.UNIVERSE_STORE_FILE_PATH;
  delete process.env.UNIVERSE_MIN_DOLLAR_VOLUME;
  delete process.env.UNIVERSE_ENRICH_LIMIT;
}

function bar({ price = 20, volume = 500000 } = {}) {
  return { t: '2026-07-13T00:00:00Z', o: price, h: price + 0.5, l: price - 0.5, c: price, v: volume };
}

test('refresh chain: Nasdaq fails, Alpaca+Finnhub succeeds and is saved with source alpaca+finnhub', async () => {
  clearEnv();
  const scratchPath = scratchFile();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FINNHUB_API_KEY = 'finnhub-key';

  const { alpacaService, nasdaqService, finnhubService, universeStore, universeBuilderService } = freshServices(scratchPath);

  nasdaqService.getScreenerRows = async () => null;
  alpacaService.getActiveAssets = async () => [
    { symbol: 'AAA', name: 'AAA Inc', exchange: 'NASDAQ' },
    { symbol: 'BBB', name: 'BBB Inc', exchange: 'NASDAQ' }
  ];
  alpacaService.getLatestDailyBars = async () => new Map([
    ['AAA', bar({ price: 30, volume: 1000000 })],
    ['BBB', bar({ price: 10, volume: 500000 })]
  ]);
  finnhubService.getCompanyProfile = async (symbol) => ({ companyName: `${symbol} Corp`, sector: 'Technology', marketCap: 5000000000 });

  await universeBuilderService.refreshUniverse({ exchange: 'NASDAQ' });
  const result = await universeStore.getUniverse('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  clearEnv();

  assert.equal(result.source, 'alpaca+finnhub');
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((row) => row.marketCap === 5000000000));
});

test('dollar-volume filtering and UNIVERSE_ENRICH_LIMIT truncation apply to Alpaca candidates', async () => {
  clearEnv();
  const scratchPath = scratchFile();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.UNIVERSE_MIN_DOLLAR_VOLUME = '1000000';
  process.env.UNIVERSE_ENRICH_LIMIT = '2';

  const { alpacaService, nasdaqService, universeStore, universeBuilderService } = freshServices(scratchPath);

  nasdaqService.getScreenerRows = async () => null;
  alpacaService.getActiveAssets = async () => [
    { symbol: 'HIGH1', name: 'High1', exchange: 'NASDAQ' },
    { symbol: 'HIGH2', name: 'High2', exchange: 'NASDAQ' },
    { symbol: 'HIGH3', name: 'High3', exchange: 'NASDAQ' },
    { symbol: 'THIN', name: 'Thin', exchange: 'NASDAQ' }
  ];
  alpacaService.getLatestDailyBars = async () => new Map([
    ['HIGH1', bar({ price: 50, volume: 100000 })], // $5,000,000
    ['HIGH2', bar({ price: 100, volume: 100000 })], // $10,000,000 - highest, must survive the limit=2 cut
    ['HIGH3', bar({ price: 20, volume: 200000 })], // $4,000,000
    ['THIN', bar({ price: 5, volume: 1000 })] // $5,000 - below the dollar-volume floor
  ]);

  await universeBuilderService.refreshUniverse({ exchange: 'NASDAQ' });
  const result = await universeStore.getUniverse('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  clearEnv();

  assert.equal(result.rows.length, 2);
  const symbols = result.rows.map((row) => row.symbol);
  assert.ok(symbols.includes('HIGH2'));
  assert.ok(!symbols.includes('THIN'));
});

test('a market cap already in the store from less than 7 days ago is reused instead of re-querying Finnhub', async () => {
  clearEnv();
  const scratchPath = scratchFile();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FINNHUB_API_KEY = 'finnhub-key';

  const { alpacaService, nasdaqService, finnhubService, universeStore, universeBuilderService } = freshServices(scratchPath);

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await universeStore.writeUniverseCache({
    NASDAQ: { generatedAt: twoDaysAgo, source: 'alpaca+finnhub', rows: [{ symbol: 'AAA', companyName: 'AAA Inc', sector: 'Technology', marketCap: 9999, price: 30, avgDollarVolume: 1000000 }] }
  });

  nasdaqService.getScreenerRows = async () => null;
  alpacaService.getActiveAssets = async () => [{ symbol: 'AAA', name: 'AAA Inc', exchange: 'NASDAQ' }];
  alpacaService.getLatestDailyBars = async () => new Map([['AAA', bar({ price: 30, volume: 1000000 })]]);

  let finnhubCallCount = 0;
  finnhubService.getCompanyProfile = async () => {
    finnhubCallCount += 1;
    return { companyName: 'AAA Inc', sector: 'Technology', marketCap: 1234567 };
  };

  await universeBuilderService.refreshUniverse({ exchange: 'NASDAQ' });
  const result = await universeStore.getUniverse('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  clearEnv();

  assert.equal(finnhubCallCount, 0);
  assert.equal(result.rows[0].marketCap, 9999);
});

test('a market cap from more than 7 days ago is not reused - Finnhub is queried again', async () => {
  clearEnv();
  const scratchPath = scratchFile();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FINNHUB_API_KEY = 'finnhub-key';

  const { alpacaService, nasdaqService, finnhubService, universeStore, universeBuilderService } = freshServices(scratchPath);

  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  await universeStore.writeUniverseCache({
    NASDAQ: { generatedAt: tenDaysAgo, source: 'alpaca+finnhub', rows: [{ symbol: 'AAA', companyName: 'AAA Inc', sector: 'Technology', marketCap: 9999, price: 30, avgDollarVolume: 1000000 }] }
  });

  nasdaqService.getScreenerRows = async () => null;
  alpacaService.getActiveAssets = async () => [{ symbol: 'AAA', name: 'AAA Inc', exchange: 'NASDAQ' }];
  alpacaService.getLatestDailyBars = async () => new Map([['AAA', bar({ price: 30, volume: 1000000 })]]);

  let finnhubCallCount = 0;
  finnhubService.getCompanyProfile = async () => {
    finnhubCallCount += 1;
    return { companyName: 'AAA Inc', sector: 'Technology', marketCap: 1234567 };
  };

  await universeBuilderService.refreshUniverse({ exchange: 'NASDAQ' });
  const result = await universeStore.getUniverse('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  clearEnv();

  assert.equal(finnhubCallCount, 1);
  assert.equal(result.rows[0].marketCap, 1234567);
});

test('total refresh failure leaves an existing store entry untouched (last-known-good)', async () => {
  clearEnv();
  const scratchPath = scratchFile();

  const { nasdaqService, universeStore, universeBuilderService } = freshServices(scratchPath);

  const existingEntry = { generatedAt: new Date().toISOString(), source: 'nasdaq', rows: [{ symbol: 'OLD', companyName: 'Old Inc', sector: 'Technology', marketCap: 111, price: 10, avgDollarVolume: 1000000 }] };
  await universeStore.writeUniverseCache({ NASDAQ: existingEntry });

  nasdaqService.getScreenerRows = async () => null; // no Alpaca keys, no FMP key -> every attempt fails

  const refreshResult = await universeBuilderService.refreshUniverse({ exchange: 'NASDAQ' });
  const result = await universeStore.getUniverse('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  clearEnv();

  assert.equal(refreshResult, null);
  assert.equal(result.rows[0].symbol, 'OLD');
});

test('a candidate whose Finnhub enrichment fails is kept with marketCap: null instead of being dropped', async () => {
  clearEnv();
  const scratchPath = scratchFile();
  process.env.ALPACA_API_KEY_ID = 'key';
  process.env.ALPACA_API_SECRET_KEY = 'secret';
  process.env.FINNHUB_API_KEY = 'finnhub-key';

  const { alpacaService, nasdaqService, finnhubService, universeStore, universeBuilderService } = freshServices(scratchPath);

  nasdaqService.getScreenerRows = async () => null;
  alpacaService.getActiveAssets = async () => [
    { symbol: 'GOOD', name: 'Good Inc', exchange: 'NASDAQ' },
    { symbol: 'FAILS', name: 'Fails Inc', exchange: 'NASDAQ' }
  ];
  alpacaService.getLatestDailyBars = async () => new Map([
    ['GOOD', bar({ price: 30, volume: 1000000 })],
    ['FAILS', bar({ price: 30, volume: 1000000 })]
  ]);
  finnhubService.getCompanyProfile = async (symbol) => (symbol === 'FAILS' ? null : { companyName: 'Good Inc', sector: 'Technology', marketCap: 5000000000 });

  await universeBuilderService.refreshUniverse({ exchange: 'NASDAQ' });
  const result = await universeStore.getUniverse('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  clearEnv();

  assert.equal(result.rows.length, 2);
  const fails = result.rows.find((row) => row.symbol === 'FAILS');
  const good = result.rows.find((row) => row.symbol === 'GOOD');
  assert.equal(fails.marketCap, null);
  assert.equal(good.marketCap, 5000000000);
});
