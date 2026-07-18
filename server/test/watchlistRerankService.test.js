const test = require('node:test');
const assert = require('node:assert/strict');

function freshWatchlistRerankService() {
  delete require.cache[require.resolve('../src/services/providers/alpacaService')];
  delete require.cache[require.resolve('../src/services/watchlistService')];
  delete require.cache[require.resolve('../src/services/watchlistRerankService')];

  return {
    alpacaService: require('../src/services/providers/alpacaService'),
    watchlistService: require('../src/services/watchlistService'),
    watchlistRerankService: require('../src/services/watchlistRerankService')
  };
}

function watchlistItem(overrides = {}) {
  return {
    ticker: 'BASE',
    companyName: 'Base Co',
    price: 20,
    daily_change: 8,
    ...overrides
  };
}

test('returns available:false when Alpaca is not configured', async () => {
  const { alpacaService, watchlistRerankService } = freshWatchlistRerankService();
  alpacaService.isConfigured = () => false;

  const result = await watchlistRerankService.rerankByPremarket({ exchange: 'NASDAQ' });

  assert.equal(result.available, false);
  assert.ok(result.message);
});

test('returns available:false when Alpaca is configured but no snapshot data comes back', async () => {
  const { alpacaService, watchlistService, watchlistRerankService } = freshWatchlistRerankService();
  alpacaService.isConfigured = () => true;
  alpacaService.getSnapshots = async () => new Map();
  watchlistService.getTomorrowWatchlist = async () => ({ watchlist: [watchlistItem({ ticker: 'GAINER' })] });

  const result = await watchlistRerankService.rerankByPremarket({ exchange: 'NASDAQ' });

  assert.equal(result.available, false);
});

test('an empty cached watchlist returns available:true with an empty list (nothing to rerank)', async () => {
  const { alpacaService, watchlistService, watchlistRerankService } = freshWatchlistRerankService();
  alpacaService.isConfigured = () => true;
  watchlistService.getTomorrowWatchlist = async () => ({ watchlist: [] });

  const result = await watchlistRerankService.rerankByPremarket({ exchange: 'NASDAQ' });

  assert.equal(result.available, true);
  assert.deepEqual(result.watchlist, []);
});

test('re-sorts by actual gap magnitude and marks a confirmed vs. faded gap correctly', async () => {
  const { alpacaService, watchlistService, watchlistRerankService } = freshWatchlistRerankService();
  alpacaService.isConfigured = () => true;
  watchlistService.getTomorrowWatchlist = async () => ({
    watchlist: [
      watchlistItem({ ticker: 'FADED', daily_change: 10 }), // predicted +10%, will actually be +1% -> faded
      watchlistItem({ ticker: 'CONFIRMED', daily_change: 6 }) // predicted +6%, will actually be +9% -> confirmed, biggest actual gap
    ]
  });
  alpacaService.getSnapshots = async () =>
    new Map([
      ['FADED', { latestTrade: { p: 20.2 }, prevDailyBar: { c: 20 } }], // +1%
      ['CONFIRMED', { latestTrade: { p: 21.8 }, prevDailyBar: { c: 20 } }] // +9%
    ]);

  const result = await watchlistRerankService.rerankByPremarket({ exchange: 'NASDAQ' });

  assert.equal(result.available, true);
  assert.equal(result.watchlist.length, 2);
  // CONFIRMED has the larger actual gap -> ranked first despite being listed second originally.
  assert.equal(result.watchlist[0].ticker, 'CONFIRMED');
  assert.equal(result.watchlist[0].gapStatus, 'confirmed');
  assert.equal(result.watchlist[0].actualGapPct, 9);
  assert.equal(result.watchlist[1].ticker, 'FADED');
  assert.equal(result.watchlist[1].gapStatus, 'faded');
});

test('a reversed gap (opposite sign from the prediction) is always classified as faded', async () => {
  const { alpacaService, watchlistService, watchlistRerankService } = freshWatchlistRerankService();
  alpacaService.isConfigured = () => true;
  watchlistService.getTomorrowWatchlist = async () => ({
    watchlist: [watchlistItem({ ticker: 'REVERSED', daily_change: 8 })]
  });
  alpacaService.getSnapshots = async () => new Map([['REVERSED', { latestTrade: { p: 19 }, prevDailyBar: { c: 20 } }]]); // -5%

  const result = await watchlistRerankService.rerankByPremarket({ exchange: 'NASDAQ' });

  assert.equal(result.watchlist[0].gapStatus, 'faded');
  assert.equal(result.watchlist[0].actualGapPct, -5);
});

test('a ticker with no snapshot data is marked unknown and sorted to the back, not thrown away', async () => {
  const { alpacaService, watchlistService, watchlistRerankService } = freshWatchlistRerankService();
  alpacaService.isConfigured = () => true;
  watchlistService.getTomorrowWatchlist = async () => ({
    watchlist: [watchlistItem({ ticker: 'NODATA', daily_change: 8 }), watchlistItem({ ticker: 'HASDATA', daily_change: 4 })]
  });
  alpacaService.getSnapshots = async () => new Map([['HASDATA', { latestTrade: { p: 20.8 }, prevDailyBar: { c: 20 } }]]); // +4%

  const result = await watchlistRerankService.rerankByPremarket({ exchange: 'NASDAQ' });

  assert.equal(result.available, true);
  assert.equal(result.watchlist.length, 2);
  assert.equal(result.watchlist[0].ticker, 'HASDATA');
  assert.equal(result.watchlist[1].ticker, 'NODATA');
  assert.equal(result.watchlist[1].gapStatus, 'unknown');
  assert.equal(result.watchlist[1].actualGapPct, null);
});
