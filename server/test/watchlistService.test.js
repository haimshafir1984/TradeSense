const test = require('node:test');
const assert = require('node:assert/strict');

function freshWatchlistService() {
  // Without Alpaca keys, funnelScanService.scanForGapAndGo (called first by buildTomorrowWatchlist)
  // must return null so these tests keep exercising the pre-funnel FMP-universe path exactly as
  // before - see docs/SPEC_DATA_FUNNEL.md section 4.
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;

  delete require.cache[require.resolve('../src/services/watchlistService')];
  delete require.cache[require.resolve('../src/services/marketDataService')];
  delete require.cache[require.resolve('../src/services/funnelScanService')];
  return {
    watchlistService: require('../src/services/watchlistService'),
    marketDataService: require('../src/services/marketDataService')
  };
}

function stock(overrides = {}) {
  return {
    ticker: 'BASE',
    companyName: 'Base Co',
    price: 20,
    daily_change: 8,
    volume: 3000000,
    average_volume_30d: 1000000,
    market_cap: 1500000000,
    high_52w: 21,
    low_52w: 10,
    adr_pct: 6,
    ...overrides
  };
}

test('buildTomorrowWatchlist filters to the gap-and-go profile and ranks by momentum/volume/proximity', async () => {
  const { watchlistService, marketDataService } = freshWatchlistService();
  const originalGetMarketData = marketDataService.getMarketData;

  marketDataService.getMarketData = async () => ({
    source: 'demo',
    stocks: [
      stock({ ticker: 'WINNER', daily_change: 12, volume: 5000000, average_volume_30d: 1000000, high_52w: 20.5 }),
      stock({ ticker: 'BIGCAP', market_cap: 50000000000 }), // filtered: market cap too large
      stock({ ticker: 'LOWADR', adr_pct: 1.5 }), // filtered: ADR below threshold
      stock({ ticker: 'LOWVOL', volume: 1000000, average_volume_30d: 1000000 }), // filtered: volume ratio too low
      stock({ ticker: 'RED', daily_change: -3 }) // filtered: not up on the day
    ]
  });

  const watchlist = await watchlistService.buildTomorrowWatchlist({ exchange: 'NASDAQ' });

  marketDataService.getMarketData = originalGetMarketData;

  assert.equal(watchlist.length, 1);
  assert.equal(watchlist[0].ticker, 'WINNER');
  assert.ok(watchlist[0].reason.length > 0);
  assert.equal(watchlist[0].hasEarningsSoon, false);
  // No Alpaca keys in the test env -> funnelScanService.scanForGapAndGo returns null and this is
  // the old FMP-universe path, now tagged accordingly (docs/SPEC_DATA_FUNNEL.md section 3.3).
  assert.equal(watchlist[0].dataSource, 'fmp-universe');
});

test('buildTomorrowWatchlist caps results at 10 and ranks strongest candidates first', async () => {
  const { watchlistService, marketDataService } = freshWatchlistService();
  const originalGetMarketData = marketDataService.getMarketData;

  const stocks = Array.from({ length: 15 }, (_, index) =>
    stock({
      ticker: `T${index}`,
      daily_change: 5 + index,
      volume: 2000000 + index * 100000,
      average_volume_30d: 1000000
    })
  );

  marketDataService.getMarketData = async () => ({ source: 'demo', stocks });

  const watchlist = await watchlistService.buildTomorrowWatchlist({ exchange: 'NASDAQ' });

  marketDataService.getMarketData = originalGetMarketData;

  assert.equal(watchlist.length, 10);
  assert.equal(watchlist[0].ticker, 'T14'); // highest daily_change/volume -> highest rank
});

test('hasEarningsSoon is set when the FMP earnings calendar mock returns an upcoming report', async () => {
  const { watchlistService, marketDataService } = freshWatchlistService();
  const originalGetMarketData = marketDataService.getMarketData;
  const originalFetch = global.fetch;
  process.env.FMP_API_KEY = 'test-key';

  marketDataService.getMarketData = async () => ({
    source: 'fmp',
    stocks: [stock({ ticker: 'EARN', daily_change: 9, volume: 4000000, average_volume_30d: 1000000 })]
  });

  global.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('symbol=EARN') ? [{ symbol: 'EARN', date: '2026-07-06' }] : [])
  });

  const watchlist = await watchlistService.buildTomorrowWatchlist({ exchange: 'NASDAQ' });

  marketDataService.getMarketData = originalGetMarketData;
  global.fetch = originalFetch;
  delete process.env.FMP_API_KEY;

  assert.equal(watchlist.length, 1);
  assert.equal(watchlist[0].hasEarningsSoon, true);
});
