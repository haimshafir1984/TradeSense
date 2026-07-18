const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function scratchUniverseStorePath() {
  return path.join(os.tmpdir(), `universeCache-theory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function freshServices(scratchPath) {
  process.env.UNIVERSE_STORE_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/services/universeStore')];
  delete require.cache[require.resolve('../src/services/vibeTradingService')];

  return {
    universeStore: require('../src/services/universeStore'),
    vibeTradingService: require('../src/services/vibeTradingService')
  };
}

function cleanup(scratchPath) {
  fs.rmSync(scratchPath, { force: true });
  delete process.env.UNIVERSE_STORE_FILE_PATH;
}

function row(symbol, overrides = {}) {
  return { symbol, companyName: `${symbol} Inc`, sector: 'Technology', marketCap: 500000000, price: 10, avgDollarVolume: 1000000, ...overrides };
}

test('falls back to the fixed legacy list when the universe store is empty', async () => {
  const scratchPath = scratchUniverseStorePath();
  const { vibeTradingService } = freshServices(scratchPath);

  const result = await vibeTradingService.buildTheoryUniverse('small_cap_breakout');

  cleanup(scratchPath);

  assert.equal(result.source, 'fixed legacy list');
  assert.match(result.tickers, /SMCI/); // one of the known fixed-list tickers
});

test('builds a systematic small_cap_breakout universe from the store, filtered and sorted by dollar volume', async () => {
  const scratchPath = scratchUniverseStorePath();
  const { universeStore, vibeTradingService } = freshServices(scratchPath);

  await universeStore.writeUniverseEntry('NASDAQ', {
    source: 'nasdaq',
    rows: [
      row('LOWVOL', { marketCap: 800000000, avgDollarVolume: 500000 }),
      row('HIGHVOL', { marketCap: 900000000, avgDollarVolume: 9000000 }),
      row('TOOBIG', { marketCap: 5000000000000 }), // above the small-cap ceiling -> excluded
      row('PENNY', { price: 0.5 }) // below the min price -> excluded
    ]
  });

  const result = await vibeTradingService.buildTheoryUniverse('small_cap_breakout');

  cleanup(scratchPath);

  assert.equal(result.source, 'systematic (universeStore)');
  assert.equal(result.tickers, 'HIGHVOL, LOWVOL'); // sorted by dollar volume descending
});

test('builds a systematic swing_momentum universe restricted to large caps', async () => {
  const scratchPath = scratchUniverseStorePath();
  const { universeStore, vibeTradingService } = freshServices(scratchPath);

  await universeStore.writeUniverseEntry('NASDAQ', {
    source: 'nasdaq',
    rows: [
      row('MEGA', { marketCap: 500000000000, avgDollarVolume: 20000000 }),
      row('SMALLCAP', { marketCap: 500000000, avgDollarVolume: 50000000 }) // liquid but too small -> excluded
    ]
  });

  const result = await vibeTradingService.buildTheoryUniverse('swing_momentum');

  cleanup(scratchPath);

  assert.equal(result.source, 'systematic (universeStore)');
  assert.equal(result.tickers, 'MEGA');
});

test('the result is deterministic across repeated calls (stable sort, tie-broken by symbol)', async () => {
  const scratchPath = scratchUniverseStorePath();
  const { universeStore, vibeTradingService } = freshServices(scratchPath);

  await universeStore.writeUniverseEntry('NASDAQ', {
    source: 'nasdaq',
    rows: [row('BBB', { avgDollarVolume: 1000000 }), row('AAA', { avgDollarVolume: 1000000 })]
  });

  const first = await vibeTradingService.buildTheoryUniverse('small_cap_breakout');
  const second = await vibeTradingService.buildTheoryUniverse('small_cap_breakout');

  cleanup(scratchPath);

  assert.equal(first.tickers, second.tickers);
  assert.equal(first.tickers, 'AAA, BBB'); // equal volume -> alphabetical tiebreak
});
