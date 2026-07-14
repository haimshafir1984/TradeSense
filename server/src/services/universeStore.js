// Disk-backed store for the nightly-built stock universe (docs/SPEC_UNIVERSE_RESILIENCE.md section
// 4.1) - same pattern as watchlistStore.js. One entry per exchange:
//   { generatedAt: ISO string, source: 'nasdaq'|'alpaca+finnhub'|'fmp', rows: [...] }
// where each row is { symbol, companyName, sector, marketCap, price, avgDollarVolume }.
//
// This exists so a scan never has to make a network call for "what stocks exist" - the nightly
// refresh (universeBuilderService.js) does that once, and every scan during the day just reads
// this file.
const fs = require('fs/promises');
const path = require('path');

// Overridable so tests can point this at a scratch file instead of the real runtime data file -
// same convention as WATCHLIST_STORE_FILE_PATH.
const universeStorePath = process.env.UNIVERSE_STORE_FILE_PATH || path.resolve(__dirname, '../data/universeCache.json');

const FRESH_MAX_AGE_HOURS = 24;
const STALE_MAX_AGE_HOURS = 72;

async function readUniverseCache() {
  try {
    const raw = await fs.readFile(universeStorePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

async function writeUniverseCache(cache) {
  await fs.writeFile(universeStorePath, JSON.stringify(cache, null, 2));
}

async function writeUniverseEntry(exchange, { source, rows }) {
  const cache = await readUniverseCache();
  cache[exchange] = { generatedAt: new Date().toISOString(), source, rows };
  await writeUniverseCache(cache);
  return cache[exchange];
}

function ageHours(generatedAt) {
  const generatedAtMs = new Date(generatedAt).getTime();
  if (!Number.isFinite(generatedAtMs)) {
    return Infinity;
  }
  return (Date.now() - generatedAtMs) / (60 * 60 * 1000);
}

// Freshness policy (spec section 4.3):
//   < 24h  -> 'fresh'   (usable, no caveat)
//   24-72h -> 'stale'   (usable, but the caller should surface a dataQuality issue)
//   > 72h  -> 'missing' (treated exactly like no file at all - caller falls back)
function classifyFreshness(hours) {
  if (hours < FRESH_MAX_AGE_HOURS) {
    return 'fresh';
  }
  if (hours < STALE_MAX_AGE_HOURS) {
    return 'stale';
  }
  return 'missing';
}

// The main read API for consumers (smallCapUniverseService.js, marketDataService.js). Returns
// null when there's no usable universe (no file, or the file is >72h old) - the caller's existing
// fallback chain (Nasdaq/FMP direct, then demo) takes over exactly as if this store didn't exist.
async function getUniverse(exchange) {
  const cache = await readUniverseCache();
  const entry = cache[exchange];

  if (!entry || !Array.isArray(entry.rows) || !entry.rows.length) {
    return null;
  }

  const hours = ageHours(entry.generatedAt);
  const freshness = classifyFreshness(hours);

  if (freshness === 'missing') {
    return null;
  }

  return {
    rows: entry.rows,
    source: entry.source,
    generatedAt: entry.generatedAt,
    isStale: freshness === 'stale'
  };
}

// Used by universeBuilderService.js to decide whether a symbol's market cap is recent enough to
// skip re-querying Finnhub (spec section 4.2 point 4) - reads the entry regardless of the
// 72h "missing" cutoff above, since a week-old market cap is still useful for this purpose even if
// the entry as a whole is too old to serve to a scan.
async function getPreviousEntry(exchange) {
  const cache = await readUniverseCache();
  return cache[exchange] || null;
}

module.exports = {
  readUniverseCache,
  writeUniverseCache,
  writeUniverseEntry,
  getUniverse,
  getPreviousEntry
};
