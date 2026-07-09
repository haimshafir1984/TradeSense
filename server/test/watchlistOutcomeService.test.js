const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function freshWatchlistOutcomeService(scratchPath) {
  process.env.WATCHLIST_OUTCOME_STORE_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/services/watchlistOutcomeStore')];
  delete require.cache[require.resolve('../src/services/watchlistOutcomeService')];
  return require('../src/services/watchlistOutcomeService');
}

test('logActualOpen saves a new record and computes gapAccuracyPct correctly (positive gap)', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-outcome-positive-${Date.now()}.json`);
  const { logActualOpen } = freshWatchlistOutcomeService(scratchPath);

  const record = await logActualOpen({
    date: '2026-07-09',
    ticker: 'amzn',
    actualOpenPrice: 110,
    modelClosePrice: 100
  });

  fs.unlinkSync(scratchPath);
  delete process.env.WATCHLIST_OUTCOME_STORE_FILE_PATH;

  assert.equal(record.ticker, 'AMZN');
  assert.equal(record.date, '2026-07-09');
  assert.equal(record.modelClosePrice, 100);
  assert.equal(record.actualOpenPrice, 110);
  assert.equal(record.gapAccuracyPct, 10);
  assert.ok(record.id);
  assert.ok(record.loggedAt);
});

test('logActualOpen computes a negative gapAccuracyPct when the open undershoots the model close', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-outcome-negative-${Date.now()}.json`);
  const { logActualOpen } = freshWatchlistOutcomeService(scratchPath);

  const record = await logActualOpen({
    date: '2026-07-09',
    ticker: 'TSLA',
    actualOpenPrice: 90,
    modelClosePrice: 100
  });

  fs.unlinkSync(scratchPath);
  delete process.env.WATCHLIST_OUTCOME_STORE_FILE_PATH;

  assert.equal(record.gapAccuracyPct, -10);
});

test('a second call for the same date+ticker updates the existing record instead of duplicating it', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-outcome-upsert-${Date.now()}.json`);
  const { logActualOpen, getOutcomesForDate } = freshWatchlistOutcomeService(scratchPath);

  const first = await logActualOpen({
    date: '2026-07-09',
    ticker: 'NVDA',
    actualOpenPrice: 105,
    modelClosePrice: 100
  });

  const second = await logActualOpen({
    date: '2026-07-09',
    ticker: 'NVDA',
    actualOpenPrice: 120,
    modelClosePrice: 100
  });

  const outcomes = await getOutcomesForDate('2026-07-09');

  fs.unlinkSync(scratchPath);
  delete process.env.WATCHLIST_OUTCOME_STORE_FILE_PATH;

  assert.equal(first.id, second.id); // same record, upserted
  assert.equal(second.actualOpenPrice, 120);
  assert.equal(second.gapAccuracyPct, 20);
  assert.equal(outcomes.size, 1); // not duplicated
  assert.equal(outcomes.get('NVDA').actualOpenPrice, 120);
});

test('getOutcomesForDate only returns records for the requested date', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-outcome-byDate-${Date.now()}.json`);
  const { logActualOpen, getOutcomesForDate } = freshWatchlistOutcomeService(scratchPath);

  await logActualOpen({ date: '2026-07-09', ticker: 'AAPL', actualOpenPrice: 210, modelClosePrice: 200 });
  await logActualOpen({ date: '2026-07-10', ticker: 'MSFT', actualOpenPrice: 410, modelClosePrice: 400 });

  const outcomesForJul9 = await getOutcomesForDate('2026-07-09');
  const outcomesForJul10 = await getOutcomesForDate('2026-07-10');

  fs.unlinkSync(scratchPath);
  delete process.env.WATCHLIST_OUTCOME_STORE_FILE_PATH;

  assert.equal(outcomesForJul9.size, 1);
  assert.ok(outcomesForJul9.has('AAPL'));
  assert.equal(outcomesForJul10.size, 1);
  assert.ok(outcomesForJul10.has('MSFT'));
});

test('logActualOpen stores the candidate scoring fields snapshotted at log time', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-outcome-features-${Date.now()}.json`);
  const { logActualOpen } = freshWatchlistOutcomeService(scratchPath);

  const record = await logActualOpen({
    date: '2026-07-09',
    ticker: 'PENG',
    actualOpenPrice: 82,
    modelClosePrice: 78.75,
    dailyChange: 25.59,
    volumeRatio: 3.1,
    adrPct: 11.72,
    highProximity: 0.97,
    rankScore: 0.62
  });

  fs.unlinkSync(scratchPath);
  delete process.env.WATCHLIST_OUTCOME_STORE_FILE_PATH;

  assert.equal(record.dailyChangeAtLog, 25.59);
  assert.equal(record.volumeRatioAtLog, 3.1);
  assert.equal(record.adrPctAtLog, 11.72);
  assert.equal(record.highProximityAtLog, 0.97);
  assert.equal(record.rankScoreAtLog, 0.62);
});

test('logActualOpen stores null for scoring fields that are missing, instead of throwing', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-outcome-features-missing-${Date.now()}.json`);
  const { logActualOpen } = freshWatchlistOutcomeService(scratchPath);

  const record = await logActualOpen({
    date: '2026-07-09',
    ticker: 'PENG',
    actualOpenPrice: 82,
    modelClosePrice: 78.75
  });

  fs.unlinkSync(scratchPath);
  delete process.env.WATCHLIST_OUTCOME_STORE_FILE_PATH;

  assert.equal(record.rankScoreAtLog, null);
  assert.equal(record.dailyChangeAtLog, null);
});

test('logActualOpen rejects a missing or non-positive actualOpenPrice with a clear error', async () => {
  const scratchPath = path.join(os.tmpdir(), `watchlist-outcome-validation-${Date.now()}.json`);
  const { logActualOpen } = freshWatchlistOutcomeService(scratchPath);

  await assert.rejects(
    () => logActualOpen({ date: '2026-07-09', ticker: 'AAPL', actualOpenPrice: 0, modelClosePrice: 100 }),
    /מחיר/
  );
  await assert.rejects(
    () => logActualOpen({ date: '2026-07-09', ticker: 'AAPL', actualOpenPrice: -5, modelClosePrice: 100 }),
    /מחיר/
  );
  await assert.rejects(
    () => logActualOpen({ date: '2026-07-09', ticker: 'AAPL', modelClosePrice: 100 }),
    /מחיר/
  );

  if (fs.existsSync(scratchPath)) {
    fs.unlinkSync(scratchPath);
  }
  delete process.env.WATCHLIST_OUTCOME_STORE_FILE_PATH;
});
