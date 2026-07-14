const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function freshUniverseStore(scratchPath) {
  process.env.UNIVERSE_STORE_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/services/universeStore')];
  return require('../src/services/universeStore');
}

function scratchFile() {
  return path.join(os.tmpdir(), `universeCache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function row(symbol, overrides = {}) {
  return { symbol, companyName: `${symbol} Inc`, sector: 'Technology', marketCap: 500000000, price: 20, avgDollarVolume: 5000000, ...overrides };
}

test('writeUniverseEntry then getUniverse round-trips rows/source for a fresh entry', async () => {
  const scratchPath = scratchFile();
  const universeStore = freshUniverseStore(scratchPath);

  await universeStore.writeUniverseEntry('NASDAQ', { source: 'alpaca+finnhub', rows: [row('AAA'), row('BBB')] });
  const result = await universeStore.getUniverse('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  delete process.env.UNIVERSE_STORE_FILE_PATH;

  assert.equal(result.source, 'alpaca+finnhub');
  assert.equal(result.rows.length, 2);
  assert.equal(result.isStale, false);
});

test('getUniverse returns null when no file exists', async () => {
  const scratchPath = scratchFile();
  const universeStore = freshUniverseStore(scratchPath);

  const result = await universeStore.getUniverse('NASDAQ');

  delete process.env.UNIVERSE_STORE_FILE_PATH;

  assert.equal(result, null);
});

test('getUniverse marks a 24-72h-old entry as stale but still returns it', async () => {
  const scratchPath = scratchFile();
  const universeStore = freshUniverseStore(scratchPath);

  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await universeStore.writeUniverseCache({
    NASDAQ: { generatedAt: fortyEightHoursAgo, source: 'nasdaq', rows: [row('AAA')] }
  });

  const result = await universeStore.getUniverse('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  delete process.env.UNIVERSE_STORE_FILE_PATH;

  assert.notEqual(result, null);
  assert.equal(result.isStale, true);
});

test('getUniverse treats an entry older than 72h as missing', async () => {
  const scratchPath = scratchFile();
  const universeStore = freshUniverseStore(scratchPath);

  const fourDaysAgo = new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString();
  await universeStore.writeUniverseCache({
    NASDAQ: { generatedAt: fourDaysAgo, source: 'nasdaq', rows: [row('AAA')] }
  });

  const result = await universeStore.getUniverse('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  delete process.env.UNIVERSE_STORE_FILE_PATH;

  assert.equal(result, null);
});

test('different exchanges are stored independently', async () => {
  const scratchPath = scratchFile();
  const universeStore = freshUniverseStore(scratchPath);

  await universeStore.writeUniverseEntry('NASDAQ', { source: 'nasdaq', rows: [row('AAA')] });
  await universeStore.writeUniverseEntry('NYSE', { source: 'fmp', rows: [row('BBB'), row('CCC')] });

  const nasdaq = await universeStore.getUniverse('NASDAQ');
  const nyse = await universeStore.getUniverse('NYSE');

  fs.rmSync(scratchPath, { force: true });
  delete process.env.UNIVERSE_STORE_FILE_PATH;

  assert.equal(nasdaq.rows.length, 1);
  assert.equal(nyse.rows.length, 2);
  assert.equal(nyse.source, 'fmp');
});

test('getPreviousEntry returns the raw entry even when it is old enough that getUniverse would call it missing', async () => {
  const scratchPath = scratchFile();
  const universeStore = freshUniverseStore(scratchPath);

  const fourDaysAgo = new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString();
  await universeStore.writeUniverseCache({
    NASDAQ: { generatedAt: fourDaysAgo, source: 'nasdaq', rows: [row('AAA', { marketCap: 999 })] }
  });

  const viaGetUniverse = await universeStore.getUniverse('NASDAQ');
  const viaGetPreviousEntry = await universeStore.getPreviousEntry('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  delete process.env.UNIVERSE_STORE_FILE_PATH;

  assert.equal(viaGetUniverse, null);
  assert.equal(viaGetPreviousEntry.rows[0].marketCap, 999);
});
