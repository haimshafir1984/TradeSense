const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function scratchUniverseStorePath() {
  return path.join(os.tmpdir(), `universeCache-scheduler-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function freshScheduler() {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;

  const scratchPath = scratchUniverseStorePath();
  process.env.UNIVERSE_STORE_FILE_PATH = scratchPath;

  delete require.cache[require.resolve('../src/services/watchlistScheduler')];
  delete require.cache[require.resolve('../src/services/watchlistService')];
  delete require.cache[require.resolve('../src/services/universeStore')];
  delete require.cache[require.resolve('../src/services/universeBuilderService')];
  delete require.cache[require.resolve('../src/services/providers/nasdaqService')];
  delete require.cache[require.resolve('../src/services/shadowScanService')];
  return {
    scratchPath,
    scheduler: require('../src/services/watchlistScheduler'),
    watchlistService: require('../src/services/watchlistService'),
    nasdaqService: require('../src/services/providers/nasdaqService'),
    shadowScanService: require('../src/services/shadowScanService')
  };
}

function cleanupUniverseStore(scratchPath) {
  fs.rmSync(scratchPath, { force: true });
  delete process.env.UNIVERSE_STORE_FILE_PATH;
}

test('checkAndRun does nothing before the scheduled hour', async () => {
  const { scheduler, watchlistService, nasdaqService, scratchPath } = freshScheduler();
  const originalGetTomorrowWatchlist = watchlistService.getTomorrowWatchlist;
  let callCount = 0;
  watchlistService.getTomorrowWatchlist = async () => {
    callCount += 1;
    return { generatedAt: new Date().toISOString(), watchlist: [] };
  };
  nasdaqService.getScreenerRows = async () => null; // no real network calls during this test

  process.env.WATCHLIST_SCHEDULE_HOUR = '22';
  await scheduler.checkAndRun(new Date('2026-07-04T15:00:00'));

  watchlistService.getTomorrowWatchlist = originalGetTomorrowWatchlist;
  delete process.env.WATCHLIST_SCHEDULE_HOUR;
  cleanupUniverseStore(scratchPath);

  assert.equal(callCount, 0);
});

test('checkAndRun refreshes the scheduled exchanges once past the scheduled hour, and only once per day', async () => {
  const { scheduler, watchlistService, nasdaqService, scratchPath } = freshScheduler();
  const originalGetTomorrowWatchlist = watchlistService.getTomorrowWatchlist;
  const calls = [];
  watchlistService.getTomorrowWatchlist = async ({ exchange, forceRefresh }) => {
    calls.push({ exchange, forceRefresh });
    return { generatedAt: new Date().toISOString(), watchlist: [] };
  };
  nasdaqService.getScreenerRows = async () => null; // no real network calls during this test

  process.env.WATCHLIST_SCHEDULE_HOUR = '22';
  process.env.WATCHLIST_SCHEDULE_EXCHANGES = 'NASDAQ,NYSE';

  await scheduler.checkAndRun(new Date('2026-07-04T22:30:00'));
  await scheduler.checkAndRun(new Date('2026-07-04T23:00:00')); // same day - should not re-run

  watchlistService.getTomorrowWatchlist = originalGetTomorrowWatchlist;
  delete process.env.WATCHLIST_SCHEDULE_HOUR;
  delete process.env.WATCHLIST_SCHEDULE_EXCHANGES;
  cleanupUniverseStore(scratchPath);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.exchange).sort(), ['NASDAQ', 'NYSE']);
  assert.ok(calls.every((call) => call.forceRefresh === true));
});

test('checkAndRun also triggers a universe refresh for each scheduled exchange', async () => {
  const { scheduler, watchlistService, nasdaqService, scratchPath } = freshScheduler();
  watchlistService.getTomorrowWatchlist = async () => ({ generatedAt: new Date().toISOString(), watchlist: [] });

  const refreshedExchanges = [];
  nasdaqService.getScreenerRows = async ({ exchange }) => {
    refreshedExchanges.push(exchange);
    return [{ symbol: 'AAA', companyName: 'AAA Inc', marketCap: 1000000000, price: 20, dailyChangePct: 1 }];
  };

  process.env.WATCHLIST_SCHEDULE_HOUR = '22';
  process.env.WATCHLIST_SCHEDULE_EXCHANGES = 'NASDAQ,NYSE';

  await scheduler.checkAndRun(new Date('2026-07-04T22:30:00'));

  delete process.env.WATCHLIST_SCHEDULE_HOUR;
  delete process.env.WATCHLIST_SCHEDULE_EXCHANGES;
  cleanupUniverseStore(scratchPath);

  assert.deepEqual(refreshedExchanges.sort(), ['NASDAQ', 'NYSE']);
});

test('checkAndRun also triggers the shadow-scan recording after the watchlist/universe refresh, using the same injected date', async () => {
  const { scheduler, watchlistService, nasdaqService, shadowScanService, scratchPath } = freshScheduler();
  watchlistService.getTomorrowWatchlist = async () => ({ generatedAt: new Date().toISOString(), watchlist: [] });
  nasdaqService.getScreenerRows = async () => null;

  const receivedNows = [];
  const originalRunShadowScans = shadowScanService.runShadowScans;
  shadowScanService.runShadowScans = async ({ now } = {}) => {
    receivedNows.push(now);
    return { ranCount: 0, runs: [] };
  };

  process.env.WATCHLIST_SCHEDULE_HOUR = '22';
  process.env.WATCHLIST_SCHEDULE_EXCHANGES = 'NASDAQ';
  const fixedNow = new Date('2026-07-06T22:30:00'); // a Monday, so a real weekend-skip can't mask this

  await scheduler.checkAndRun(fixedNow);

  shadowScanService.runShadowScans = originalRunShadowScans;
  delete process.env.WATCHLIST_SCHEDULE_HOUR;
  delete process.env.WATCHLIST_SCHEDULE_EXCHANGES;
  cleanupUniverseStore(scratchPath);

  assert.equal(receivedNows.length, 1);
  assert.equal(receivedNows[0].getTime(), fixedNow.getTime());
});
