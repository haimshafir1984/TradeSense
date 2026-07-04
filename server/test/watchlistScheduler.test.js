const test = require('node:test');
const assert = require('node:assert/strict');

function freshScheduler() {
  delete require.cache[require.resolve('../src/services/watchlistScheduler')];
  delete require.cache[require.resolve('../src/services/watchlistService')];
  return {
    scheduler: require('../src/services/watchlistScheduler'),
    watchlistService: require('../src/services/watchlistService')
  };
}

test('checkAndRun does nothing before the scheduled hour', async () => {
  const { scheduler, watchlistService } = freshScheduler();
  const originalGetTomorrowWatchlist = watchlistService.getTomorrowWatchlist;
  let callCount = 0;
  watchlistService.getTomorrowWatchlist = async () => {
    callCount += 1;
    return { generatedAt: new Date().toISOString(), watchlist: [] };
  };

  process.env.WATCHLIST_SCHEDULE_HOUR = '22';
  await scheduler.checkAndRun(new Date('2026-07-04T15:00:00'));

  watchlistService.getTomorrowWatchlist = originalGetTomorrowWatchlist;
  delete process.env.WATCHLIST_SCHEDULE_HOUR;

  assert.equal(callCount, 0);
});

test('checkAndRun refreshes the scheduled exchanges once past the scheduled hour, and only once per day', async () => {
  const { scheduler, watchlistService } = freshScheduler();
  const originalGetTomorrowWatchlist = watchlistService.getTomorrowWatchlist;
  const calls = [];
  watchlistService.getTomorrowWatchlist = async ({ exchange, forceRefresh }) => {
    calls.push({ exchange, forceRefresh });
    return { generatedAt: new Date().toISOString(), watchlist: [] };
  };

  process.env.WATCHLIST_SCHEDULE_HOUR = '22';
  process.env.WATCHLIST_SCHEDULE_EXCHANGES = 'NASDAQ,NYSE';

  await scheduler.checkAndRun(new Date('2026-07-04T22:30:00'));
  await scheduler.checkAndRun(new Date('2026-07-04T23:00:00')); // same day - should not re-run

  watchlistService.getTomorrowWatchlist = originalGetTomorrowWatchlist;
  delete process.env.WATCHLIST_SCHEDULE_HOUR;
  delete process.env.WATCHLIST_SCHEDULE_EXCHANGES;

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.exchange).sort(), ['NASDAQ', 'NYSE']);
  assert.ok(calls.every((call) => call.forceRefresh === true));
});
