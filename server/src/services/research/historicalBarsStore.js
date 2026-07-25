// Disk-backed cache for raw daily bars used by the anomaly-mining CLI (docs/SPEC_ANOMALY_MINING.md
// section 5.2). Same pattern as universeStore.js/watchlistStore.js. Exists so re-running the miner
// (tuning thresholds, re-running the report) doesn't re-download ~680 days of bars for ~700
// symbols from Alpaca every time - only `--refresh-bars` does that.
//
// On-disk shape is a compact array-of-arrays per bar (not the {t,o,h,l,c,v} object shape used
// elsewhere) purely to keep the file size down - one entry per exchange:
//   { generatedAt: ISO string, feed: 'iex'|'delayed_sip', exchange: 'NASDAQ',
//     bars: { SYMBOL: [[t,o,h,l,c,v], ...], ... } }
const fs = require('fs/promises');
const path = require('path');

const barsStorePath = process.env.RESEARCH_BARS_FILE_PATH || path.resolve(__dirname, '../../data/researchBars.json');

async function readBarsCache() {
  try {
    const raw = await fs.readFile(barsStorePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeBarsCache(cache) {
  await fs.mkdir(path.dirname(barsStorePath), { recursive: true });
  await fs.writeFile(barsStorePath, JSON.stringify(cache));
}

function toCompactBar(bar) {
  return [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v];
}

function fromCompactBar(row) {
  const [t, o, h, l, c, v] = row;
  return { t, o, h, l, c, v };
}

// barsBySymbol: Map<symbol, barObject[]> (the shape alpacaService.getDailyBars returns).
async function writeBarsEntry(exchange, { feed, barsBySymbol }) {
  const compactBars = {};
  for (const [symbol, bars] of barsBySymbol) {
    compactBars[symbol] = bars.map(toCompactBar);
  }

  const cache = await readBarsCache();
  cache[exchange] = { generatedAt: new Date().toISOString(), feed, exchange, bars: compactBars };
  await writeBarsCache(cache);
  return cache[exchange];
}

// Returns { generatedAt, feed, bars: Map<symbol, barObject[]> } or null if nothing is cached for
// this exchange yet.
async function getBars(exchange) {
  const cache = await readBarsCache();
  const entry = cache[exchange];

  if (!entry || !entry.bars || typeof entry.bars !== 'object') {
    return null;
  }

  const bars = new Map();
  for (const [symbol, rows] of Object.entries(entry.bars)) {
    if (Array.isArray(rows) && rows.length) {
      bars.set(symbol, rows.map(fromCompactBar));
    }
  }

  return { generatedAt: entry.generatedAt, feed: entry.feed, bars };
}

module.exports = {
  readBarsCache,
  writeBarsCache,
  writeBarsEntry,
  getBars
};
