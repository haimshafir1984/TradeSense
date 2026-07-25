const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function freshBarsStore(scratchPath) {
  process.env.RESEARCH_BARS_FILE_PATH = scratchPath;
  delete require.cache[require.resolve('../src/services/research/historicalBarsStore')];
  return require('../src/services/research/historicalBarsStore');
}

function scratchFile() {
  return path.join(os.tmpdir(), `researchBars-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function bar(t, c) {
  return { t, o: c - 0.5, h: c + 1, l: c - 1, c, v: 100000 };
}

test('writeBarsEntry then getBars round-trips bars/feed for a fresh entry', async () => {
  const scratchPath = scratchFile();
  const store = freshBarsStore(scratchPath);

  const barsBySymbol = new Map([
    ['AAA', [bar('2026-01-01T00:00:00Z', 10), bar('2026-01-02T00:00:00Z', 10.5)]],
    ['BBB', [bar('2026-01-01T00:00:00Z', 20)]]
  ]);

  await store.writeBarsEntry('NASDAQ', { feed: 'iex', barsBySymbol });
  const result = await store.getBars('NASDAQ');

  fs.rmSync(scratchPath, { force: true });
  delete process.env.RESEARCH_BARS_FILE_PATH;

  assert.equal(result.feed, 'iex');
  assert.equal(result.bars.size, 2);
  assert.equal(result.bars.get('AAA').length, 2);
  assert.deepEqual(result.bars.get('AAA')[0], bar('2026-01-01T00:00:00Z', 10));
  assert.equal(result.bars.get('BBB')[0].c, 20);
});

test('getBars returns null when nothing is cached for the exchange', async () => {
  const scratchPath = scratchFile();
  const store = freshBarsStore(scratchPath);

  const result = await store.getBars('NASDAQ');

  delete process.env.RESEARCH_BARS_FILE_PATH;

  assert.equal(result, null);
});

test('different exchanges are stored independently', async () => {
  const scratchPath = scratchFile();
  const store = freshBarsStore(scratchPath);

  await store.writeBarsEntry('NASDAQ', { feed: 'iex', barsBySymbol: new Map([['AAA', [bar('2026-01-01T00:00:00Z', 10)]]]) });
  await store.writeBarsEntry('NYSE', { feed: 'delayed_sip', barsBySymbol: new Map([['ZZZ', [bar('2026-01-01T00:00:00Z', 30)]]]) });

  const nasdaq = await store.getBars('NASDAQ');
  const nyse = await store.getBars('NYSE');

  fs.rmSync(scratchPath, { force: true });
  delete process.env.RESEARCH_BARS_FILE_PATH;

  assert.equal(nasdaq.bars.has('AAA'), true);
  assert.equal(nyse.bars.has('ZZZ'), true);
  assert.equal(nyse.feed, 'delayed_sip');
});
