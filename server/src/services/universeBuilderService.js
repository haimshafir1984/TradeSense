// Builds the nightly stock universe that universeStore.js persists (docs/SPEC_UNIVERSE_RESILIENCE.md
// section 4.2). Runs a chain of attempts and saves the first one that produces usable rows:
//   1. Nasdaq screener (nasdaqService) - one cheap call, works locally but is blocked from Render.
//   2. Alpaca (assets + latest bars, local liquidity filter) + Finnhub (market cap enrichment,
//      with a 7-day reuse window so repeat runs mostly skip re-querying already-known caps).
//   3. FMP screener (fallback, spends its daily quota only when the two quota-free options failed).
// If every attempt fails, the store is left untouched (last-known-good) - refreshUniverse just
// returns null and the caller keeps using whatever was already on disk.
const alpacaService = require('./providers/alpacaService');
const nasdaqService = require('./providers/nasdaqService');
const finnhubService = require('./providers/finnhubService');
const universeStore = require('./universeStore');
// marketDataService.js requires this module too (lazily, inside getAlpacaNasdaqMarketData - see
// there for why), so this stays a plain top-level require here; only the other direction needs to
// be lazy to avoid a load-order cycle.
const marketDataService = require('./marketDataService');
const { SMALL_CAP_THRESHOLDS } = require('../config/scoringConfig');

const NASDAQ_UNIVERSE_LIMIT = 1000;
const UNIVERSE_MIN_DOLLAR_VOLUME = Number(process.env.UNIVERSE_MIN_DOLLAR_VOLUME) || 2000000;
const UNIVERSE_ENRICH_LIMIT = Number(process.env.UNIVERSE_ENRICH_LIMIT) || 400;
const FINNHUB_ENRICH_CONCURRENCY = 10;
const MARKET_CAP_REUSE_MAX_AGE_DAYS = 7;

// De-dupes concurrent refresh attempts for the same exchange (e.g. several scans arriving while
// the store is empty) so they all await one refresh instead of triggering N parallel ones.
const inFlightRefreshes = new Map();

function refreshUniverseOnce(exchange) {
  if (!inFlightRefreshes.has(exchange)) {
    const promise = refreshUniverse({ exchange }).finally(() => inFlightRefreshes.delete(exchange));
    inFlightRefreshes.set(exchange, promise);
  }
  return inFlightRefreshes.get(exchange);
}

// The read path consumers actually call (docs/SPEC_UNIVERSE_RESILIENCE.md section 4.4):
//   - fresh (<24h)  -> returned as-is, no refresh triggered.
//   - stale (24-72h) -> returned immediately (still usable), refresh kicked off in the background
//     for the next call to pick up - a scan should never wait on a ~minutes-long rebuild.
//   - missing (>72h or no file) -> refresh is awaited synchronously, since the alternative is
//     falling all the way to demo data for this request.
async function getUniverseWithLazyRefresh(exchange) {
  const existing = await universeStore.getUniverse(exchange);

  if (existing && !existing.isStale) {
    return existing;
  }

  if (existing && existing.isStale) {
    refreshUniverseOnce(exchange).catch((error) => {
      console.warn(`[universe] Background refresh failed for ${exchange}: ${error.message}`);
    });
    return existing;
  }

  await refreshUniverseOnce(exchange);
  return universeStore.getUniverse(exchange);
}

// Maps a universeStore `source` value to the per-stock/per-scan data_source label the rest of the
// app already uses (docs/SPEC_PROVIDER_REBALANCE.md's 'alpaca+nasdaq'/'alpaca+fmp-screener', plus
// the new 'alpaca+finnhub').
function dataSourceLabelFor(universeSource) {
  if (universeSource === 'nasdaq') {
    return 'alpaca+nasdaq';
  }
  if (universeSource === 'alpaca+finnhub') {
    return 'alpaca+finnhub';
  }
  return 'alpaca+fmp-screener';
}

async function refreshUniverse({ exchange = 'NASDAQ' } = {}) {
  const nasdaqRows = await buildFromNasdaq(exchange);
  if (nasdaqRows) {
    console.log(`[universe] Refreshed ${exchange} from nasdaq. count=${nasdaqRows.length}`);
    return universeStore.writeUniverseEntry(exchange, { source: 'nasdaq', rows: nasdaqRows });
  }

  const alpacaFinnhubRows = await buildFromAlpacaFinnhub(exchange);
  if (alpacaFinnhubRows) {
    console.log(`[universe] Refreshed ${exchange} from alpaca+finnhub. count=${alpacaFinnhubRows.length}`);
    return universeStore.writeUniverseEntry(exchange, { source: 'alpaca+finnhub', rows: alpacaFinnhubRows });
  }

  const fmpRows = await buildFromFmp(exchange);
  if (fmpRows) {
    console.log(`[universe] Refreshed ${exchange} from fmp. count=${fmpRows.length}`);
    return universeStore.writeUniverseEntry(exchange, { source: 'fmp', rows: fmpRows });
  }

  console.warn(`[universe] All refresh attempts failed for ${exchange} - keeping last-known-good on disk.`);
  return null;
}

async function buildFromNasdaq(exchange) {
  const rows = await nasdaqService.getScreenerRows({ exchange, limit: NASDAQ_UNIVERSE_LIMIT });
  if (!rows || !rows.length) {
    return null;
  }

  return rows.map((row) => ({
    symbol: row.symbol,
    companyName: row.companyName,
    sector: 'Unknown',
    marketCap: row.marketCap,
    price: row.price,
    avgDollarVolume: null
  }));
}

async function buildFromAlpacaFinnhub(exchange) {
  if (!alpacaService.isConfigured()) {
    return null;
  }

  const assets = await alpacaService.getActiveAssets({ exchange });
  if (!assets.length) {
    return null;
  }

  const nameBySymbol = new Map(assets.map((asset) => [asset.symbol, asset.name]));
  const symbols = assets.map((asset) => asset.symbol);
  const latestBars = await alpacaService.getLatestDailyBars({ symbols });

  if (!latestBars.size) {
    return null;
  }

  const candidates = [];
  for (const [symbol, bar] of latestBars) {
    const price = Number(bar?.c);
    const volume = Number(bar?.v);

    if (!Number.isFinite(price) || !Number.isFinite(volume) || price < SMALL_CAP_THRESHOLDS.minPrice) {
      continue;
    }

    const avgDollarVolume = price * volume;
    if (avgDollarVolume < UNIVERSE_MIN_DOLLAR_VOLUME) {
      continue;
    }

    candidates.push({ symbol, companyName: nameBySymbol.get(symbol) || symbol, price, avgDollarVolume });
  }

  if (!candidates.length) {
    return null;
  }

  const topCandidates = candidates
    .sort((left, right) => right.avgDollarVolume - left.avgDollarVolume)
    .slice(0, UNIVERSE_ENRICH_LIMIT);

  const previousEntry = await universeStore.getPreviousEntry(exchange);
  const reusableMarketCaps = buildReusableMarketCapMap(previousEntry);

  await enrichMarketCaps(topCandidates, reusableMarketCaps);

  return topCandidates.map((candidate) => ({
    symbol: candidate.symbol,
    companyName: candidate.companyName,
    sector: candidate.sector || 'Unknown',
    marketCap: Number.isFinite(candidate.marketCap) ? candidate.marketCap : null,
    price: candidate.price,
    avgDollarVolume: candidate.avgDollarVolume
  }));
}

// Reused only when the previous universe entry itself is recent enough that its market caps are
// unlikely to be stale (spec section 4.2 point 4) - a week-old market cap barely moves.
function buildReusableMarketCapMap(previousEntry) {
  const map = new Map();

  if (!previousEntry || !Array.isArray(previousEntry.rows)) {
    return map;
  }

  const ageMs = Date.now() - new Date(previousEntry.generatedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (!(ageDays <= MARKET_CAP_REUSE_MAX_AGE_DAYS)) {
    return map;
  }

  for (const row of previousEntry.rows) {
    if (row?.symbol && Number.isFinite(row.marketCap)) {
      map.set(row.symbol, { marketCap: row.marketCap, companyName: row.companyName, sector: row.sector });
    }
  }

  return map;
}

// Mutates each candidate in place, adding marketCap/sector (and companyName when Finnhub has a
// better one). A candidate whose enrichment fails - or who has no reusable/Finnhub data at all -
// is left with marketCap: null rather than dropped (spec section 4.2 point 4: still usable for the
// regular universe, just not for small-cap market-cap filtering).
async function enrichMarketCaps(candidates, reusableMarketCaps) {
  const toQuery = [];

  for (const candidate of candidates) {
    const reused = reusableMarketCaps.get(candidate.symbol);
    if (reused) {
      candidate.marketCap = reused.marketCap;
      candidate.sector = reused.sector;
      if (reused.companyName) {
        candidate.companyName = reused.companyName;
      }
    } else {
      toQuery.push(candidate);
    }
  }

  if (!toQuery.length || !finnhubService.isConfigured()) {
    return;
  }

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < toQuery.length) {
      const candidate = toQuery[nextIndex];
      nextIndex += 1;

      const profile = await finnhubService.getCompanyProfile(candidate.symbol);
      if (profile) {
        candidate.marketCap = Number.isFinite(profile.marketCap) ? profile.marketCap : null;
        candidate.sector = profile.sector || 'Unknown';
        if (profile.companyName) {
          candidate.companyName = profile.companyName;
        }
      }
    }
  }

  const workerCount = Math.min(FINNHUB_ENRICH_CONCURRENCY, toQuery.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

async function buildFromFmp(exchange) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    return null;
  }

  const url =
    `https://financialmodelingprep.com/stable/company-screener?exchange=${exchange}` +
    `&isActivelyTrading=true` +
    `&limit=${UNIVERSE_ENRICH_LIMIT}` +
    `&apikey=${apiKey}`;

  const result = await marketDataService.fetchJson(url, `fmp-universe-screener:${exchange}`, true);
  if (!result.ok || !Array.isArray(result.data)) {
    return null;
  }

  const rows = result.data
    .filter((item) => item?.symbol && item?.companyName && Number.isFinite(Number(item.marketCap)) && Number(item.marketCap) > 0)
    .filter((item) => !item.symbol.includes('/') && !item.symbol.includes('.'))
    .map((item) => ({
      symbol: item.symbol,
      companyName: item.companyName,
      sector: item.sector || 'Unknown',
      marketCap: Number(item.marketCap),
      price: Number.isFinite(Number(item.price)) ? Number(item.price) : null,
      avgDollarVolume: null
    }));

  return rows.length ? rows : null;
}

module.exports = {
  refreshUniverse,
  getUniverseWithLazyRefresh,
  dataSourceLabelFor
};
