// Dedicated universe for the small_cap_breakout strategy (docs/SPEC_SMALL_CAP_STRATEGY.md section
// 2): the regular ~40-symbol FMP universe skews to mega-caps, so a strategy looking for small,
// volatile stocks needs its own source. Two stages: one FMP screener call (candidates + real
// market cap, no per-symbol quote/profile calls) followed by a single batched Alpaca bars request
// for the technicals. Returns null (never throws) whenever Alpaca isn't configured or either stage
// comes back empty/failed - the caller (scannerService.js) falls back to the regular universe.
const alpacaService = require('./providers/alpacaService');
const nasdaqService = require('./providers/nasdaqService');
const universeBuilderService = require('./universeBuilderService');
const { fetchJson } = require('./marketDataService');
const { buildStockFromBars } = require('./barsStockBuilder');
const { SMALL_CAP_THRESHOLDS } = require('../config/scoringConfig');

// How many candidates to pull from the FMP screener per exchange. Configurable since the right
// size trades off "more candidates" against FMP call volume for stage 3 enrichment elsewhere.
const SMALL_CAP_UNIVERSE_SIZE = Number(process.env.SMALL_CAP_UNIVERSE_SIZE) || 150;
// Screener-level liquidity floor - looser than any scoring threshold, just keeps totally
// untradable names out of the batch sent to Alpaca.
const SCREENER_MIN_VOLUME = 300000;
// Minimum bars needed for the ADR/MA50/high-52w math below to mean anything (20-day ADR window +
// a previous-close comparison, same floor swing/funnel logic uses elsewhere).
const MIN_BARS_FOR_UNIVERSE = 60;
const HISTORY_DAYS = 420; // ~290 trading days - enough for a (possibly partial) MA200.

const UNIVERSE_CACHE = new Map();
const UNIVERSE_CACHE_TTL_MS = 5 * 60 * 1000;

async function getSmallCapUniverse({ exchange = 'NASDAQ' } = {}) {
  if (!alpacaService.isConfigured()) {
    return null;
  }

  const cacheKey = `smallcap:${exchange}`;
  const cached = readCache(cacheKey);
  if (cached) {
    return cached;
  }

  const screenerResult = await fetchScreenerCandidates(exchange);
  if (!screenerResult || !screenerResult.candidates.length) {
    return null;
  }

  const stocks = await buildUniverseFromBars(exchange, screenerResult.candidates, screenerResult.dataSource);
  if (!stocks.length) {
    return null;
  }

  for (const stock of stocks) {
    stock.dataStale = screenerResult.isStale === true;
  }

  writeCache(cacheKey, stocks);
  return stocks;
}

// Stage 1: candidates that are already small-cap, liquid, and above a penny-stock price floor -
// with real market cap attached, so nothing per-symbol is needed later. Tries the nightly-built
// universeStore first (zero network calls on the common path - see
// docs/SPEC_UNIVERSE_RESILIENCE.md), then falls back to its own direct Nasdaq call, then its own
// direct FMP call, exactly as before the store existed - this keeps behavior unchanged whenever
// the store has nothing usable (e.g. a fresh install before the first nightly refresh).
async function fetchScreenerCandidates(exchange) {
  const storeResult = await fetchCandidatesFromStore(exchange);
  if (storeResult) {
    return storeResult;
  }

  const nasdaqCandidates = await fetchNasdaqCandidates(exchange);
  if (nasdaqCandidates) {
    return { candidates: nasdaqCandidates, dataSource: 'alpaca+nasdaq', isStale: false };
  }

  const fmpCandidates = await fetchFmpCandidates(exchange);
  if (fmpCandidates) {
    return { candidates: fmpCandidates, dataSource: 'alpaca+fmp-screener', isStale: false };
  }

  return null;
}

async function fetchCandidatesFromStore(exchange) {
  const universe = await universeBuilderService.getUniverseWithLazyRefresh(exchange);
  if (!universe) {
    return null;
  }

  const candidates = universe.rows
    .filter((row) => Number.isFinite(row.marketCap) && row.marketCap > 0 && row.marketCap <= SMALL_CAP_THRESHOLDS.marketCapCeiling)
    .filter((row) => Number.isFinite(row.price) && row.price >= SMALL_CAP_THRESHOLDS.minPrice)
    .slice(0, SMALL_CAP_UNIVERSE_SIZE)
    .map((row) => ({
      symbol: row.symbol,
      companyName: row.companyName,
      sector: row.sector || 'Unknown',
      marketCap: row.marketCap
    }));

  if (!candidates.length) {
    return null;
  }

  return { candidates, dataSource: universeBuilderService.dataSourceLabelFor(universe.source), isStale: universe.isStale };
}

async function fetchNasdaqCandidates(exchange) {
  const rows = await nasdaqService.getScreenerRows({
    exchange,
    marketCapTiers: ['small', 'micro'],
    limit: SMALL_CAP_UNIVERSE_SIZE
  });
  if (!rows) {
    return null;
  }

  const candidates = rows
    .filter((row) => Number.isFinite(row.marketCap) && row.marketCap > 0 && row.marketCap <= SMALL_CAP_THRESHOLDS.marketCapCeiling)
    .filter((row) => Number.isFinite(row.price) && row.price >= SMALL_CAP_THRESHOLDS.minPrice)
    .slice(0, SMALL_CAP_UNIVERSE_SIZE)
    .map((row) => ({
      symbol: row.symbol,
      companyName: row.companyName,
      sector: 'Unknown',
      marketCap: row.marketCap
    }));

  return candidates.length ? candidates : null;
}

async function fetchFmpCandidates(exchange) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    return null;
  }

  const url =
    `https://financialmodelingprep.com/stable/company-screener?exchange=${exchange}` +
    `&isActivelyTrading=true` +
    `&marketCapLowerThan=${SMALL_CAP_THRESHOLDS.marketCapCeiling}` +
    `&priceMoreThan=${SMALL_CAP_THRESHOLDS.minPrice}` +
    `&volumeMoreThan=${SCREENER_MIN_VOLUME}` +
    `&limit=${SMALL_CAP_UNIVERSE_SIZE}` +
    `&apikey=${apiKey}`;

  const result = await fetchJson(url, `fmp-smallcap-screener:${exchange}`, true);
  if (!result.ok || !Array.isArray(result.data)) {
    return null;
  }

  const candidates = result.data
    .filter((item) => item?.symbol && item?.companyName && Number.isFinite(Number(item.marketCap)) && Number(item.marketCap) > 0)
    .filter((item) => !item.symbol.includes('/') && !item.symbol.includes('.'))
    .slice(0, SMALL_CAP_UNIVERSE_SIZE)
    .map((item) => ({
      symbol: item.symbol,
      companyName: item.companyName,
      sector: item.sector || 'Unknown',
      marketCap: Number(item.marketCap)
    }));

  return candidates.length ? candidates : null;
}

// Stage 2: one batched Alpaca bars request for every candidate's technicals.
async function buildUniverseFromBars(exchange, candidates, dataSource) {
  const candidateBySymbol = new Map(candidates.map((candidate) => [candidate.symbol, candidate]));
  const symbols = candidates.map((candidate) => candidate.symbol);
  const barsBySymbol = await alpacaService.getDailyBars({ symbols, days: HISTORY_DAYS });

  const stocks = [];

  for (const [symbol, bars] of barsBySymbol) {
    if (!Array.isArray(bars) || bars.length < MIN_BARS_FOR_UNIVERSE) {
      continue;
    }

    const candidate = candidateBySymbol.get(symbol);
    if (!candidate) {
      continue;
    }

    const stock = buildStockFromBars({ exchange, candidate, bars, dataSource });
    if (stock) {
      stocks.push(stock);
    }
  }

  return stocks;
}

function readCache(key) {
  const entry = UNIVERSE_CACHE.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    UNIVERSE_CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key, value) {
  UNIVERSE_CACHE.set(key, { value, expiresAt: Date.now() + UNIVERSE_CACHE_TTL_MS });
}

module.exports = {
  getSmallCapUniverse
};
