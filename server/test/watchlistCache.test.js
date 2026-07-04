const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function freshWatchlistService(scratchPath) {
  process.env.WATCHLIST_STORE_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/services/watchlistStore')];
  delete require.cache[require.resolve('../src/services/watchlistService')];
  delete require.cache[require.resolve('../src/services/marketDataService')];
  return {
    watchlistService: require('../src/services/watchlistService'),
    marketDataService: require('../src/services/marketDataService')
  };
}

function stock(ticker) {
  return {
    ticker,
    companyName: `${ticker} Co`,
    price: 20,
    daily_change: 8,
    volume: 3000000,
    average_volume_30d: 1000000,
    market_cap: 1500000000,
    high_52w: 21,
    low_52w: 10,
    adr_pct: 6
  };
}

test('getTomorrowWatchlist computes once and serves the cached result on subsequent calls within the freshness window', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-cache-test-${Date.now()}.json`);
  const { watchlistService, marketDataService } = freshWatchlistService(scratchPath);
  const originalGetMarketData = marketDataService.getMarketData;
  let callCount = 0;

  marketDataService.getMarketData = async () => {
    callCount += 1;
    return { source: 'demo', stocks: [stock(`T${callCount}`)] };
  };

  const first = await watchlistService.getTomorrowWatchlist({ exchange: 'NASDAQ' });
  const second = await watchlistService.getTomorrowWatchlist({ exchange: 'NASDAQ' });

  marketDataService.getMarketData = originalGetMarketData;
  fs.unlinkSync(scratchPath);
  delete process.env.WATCHLIST_STORE_FILE_PATH;

  assert.equal(callCount, 1); // second call served from cache, no recompute
  assert.equal(first.watchlist[0].ticker, 'T1');
  assert.equal(second.watchlist[0].ticker, 'T1');
  assert.equal(second.generatedAt, first.generatedAt);
});

test('forceRefresh recomputes even when the cache is still fresh', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-cache-force-${Date.now()}.json`);
  const { watchlistService, marketDataService } = freshWatchlistService(scratchPath);
  const originalGetMarketData = marketDataService.getMarketData;
  let callCount = 0;

  marketDataService.getMarketData = async () => {
    callCount += 1;
    return { source: 'demo', stocks: [stock(`T${callCount}`)] };
  };

  await watchlistService.getTomorrowWatchlist({ exchange: 'NASDAQ' });
  const refreshed = await watchlistService.getTomorrowWatchlist({ exchange: 'NASDAQ', forceRefresh: true });

  marketDataService.getMarketData = originalGetMarketData;
  fs.unlinkSync(scratchPath);
  delete process.env.WATCHLIST_STORE_FILE_PATH;

  assert.equal(callCount, 2);
  assert.equal(refreshed.watchlist[0].ticker, 'T2');
});

test('a stale cache (past the freshness window) is recomputed automatically', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-cache-stale-${Date.now()}.json`);
  const { watchlistService, marketDataService } = freshWatchlistService(scratchPath);
  const originalGetMarketData = marketDataService.getMarketData;
  let callCount = 0;

  marketDataService.getMarketData = async () => {
    callCount += 1;
    return { source: 'demo', stocks: [stock(`T${callCount}`)] };
  };

  await watchlistService.getTomorrowWatchlist({ exchange: 'NASDAQ' });

  const raw = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
  raw.NASDAQ.generatedAt = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(); // > 12h old
  fs.writeFileSync(scratchPath, JSON.stringify(raw, null, 2));

  const refreshed = await watchlistService.getTomorrowWatchlist({ exchange: 'NASDAQ' });

  marketDataService.getMarketData = originalGetMarketData;
  fs.unlinkSync(scratchPath);
  delete process.env.WATCHLIST_STORE_FILE_PATH;

  assert.equal(callCount, 2);
  assert.equal(refreshed.watchlist[0].ticker, 'T2');
});

test('different exchanges are cached independently', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-cache-exchange-${Date.now()}.json`);
  const { watchlistService, marketDataService } = freshWatchlistService(scratchPath);
  const originalGetMarketData = marketDataService.getMarketData;

  marketDataService.getMarketData = async (exchange) => ({ source: 'demo', stocks: [stock(exchange)] });

  const nasdaq = await watchlistService.getTomorrowWatchlist({ exchange: 'NASDAQ' });
  const nyse = await watchlistService.getTomorrowWatchlist({ exchange: 'NYSE' });

  marketDataService.getMarketData = originalGetMarketData;
  fs.unlinkSync(scratchPath);
  delete process.env.WATCHLIST_STORE_FILE_PATH;

  assert.equal(nasdaq.watchlist[0].ticker, 'NASDAQ');
  assert.equal(nyse.watchlist[0].ticker, 'NYSE');
});
