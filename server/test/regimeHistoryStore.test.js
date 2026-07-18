const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function freshRegimeHistoryStore(scratchPath) {
  process.env.REGIME_HISTORY_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/services/regimeHistoryStore')];
  return require('../src/services/regimeHistoryStore');
}

function cleanup(scratchPath) {
  fs.rmSync(scratchPath, { force: true });
  delete process.env.REGIME_HISTORY_FILE_PATH;
}

test('recordRegimeSnapshot appends a new day and getRecentEntries returns it', async () => {
  const scratchPath = path.join(os.tmpdir(), `regimeHistory-test-${Date.now()}.json`);
  const store = freshRegimeHistoryStore(scratchPath);

  await store.recordRegimeSnapshot('NASDAQ', 'bullish', new Date('2026-07-10'));
  const entries = await store.getRecentEntries('NASDAQ');

  cleanup(scratchPath);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].date, '2026-07-10');
  assert.equal(entries[0].regime, 'bullish');
});

test('a second recording on the same calendar day replaces (not duplicates) that day\'s entry', async () => {
  const scratchPath = path.join(os.tmpdir(), `regimeHistory-sameday-test-${Date.now()}.json`);
  const store = freshRegimeHistoryStore(scratchPath);
  const sameDay = new Date('2026-07-10T09:00:00Z');
  const laterSameDay = new Date('2026-07-10T21:00:00Z');

  await store.recordRegimeSnapshot('NASDAQ', 'volatile', sameDay);
  await store.recordRegimeSnapshot('NASDAQ', 'bullish', laterSameDay);
  const entries = await store.getRecentEntries('NASDAQ');

  cleanup(scratchPath);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].regime, 'bullish');
});

test('different exchanges are stored independently', async () => {
  const scratchPath = path.join(os.tmpdir(), `regimeHistory-exchange-test-${Date.now()}.json`);
  const store = freshRegimeHistoryStore(scratchPath);

  await store.recordRegimeSnapshot('NASDAQ', 'bullish', new Date('2026-07-10'));
  await store.recordRegimeSnapshot('NYSE', 'bearish', new Date('2026-07-10'));

  const nasdaqEntries = await store.getRecentEntries('NASDAQ');
  const nyseEntries = await store.getRecentEntries('NYSE');

  cleanup(scratchPath);

  assert.equal(nasdaqEntries[0].regime, 'bullish');
  assert.equal(nyseEntries[0].regime, 'bearish');
});

test('getRecentEntries returns an empty array when no file exists yet', async () => {
  const scratchPath = path.join(os.tmpdir(), `regimeHistory-missing-test-${Date.now()}.json`);
  const store = freshRegimeHistoryStore(scratchPath);

  const entries = await store.getRecentEntries('NASDAQ');

  cleanup(scratchPath);

  assert.deepEqual(entries, []);
});
