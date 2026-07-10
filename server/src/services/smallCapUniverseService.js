// Dedicated universe for the small_cap_breakout strategy (docs/SPEC_SMALL_CAP_STRATEGY.md section
// 2): the regular ~40-symbol FMP universe skews to mega-caps, so a strategy looking for small,
// volatile stocks needs its own source. Two stages: one FMP screener call (candidates + real
// market cap, no per-symbol quote/profile calls) followed by a single batched Alpaca bars request
// for the technicals. Returns null (never throws) whenever Alpaca isn't configured or either stage
// comes back empty/failed - the caller (scannerService.js) falls back to the regular universe.
const alpacaService = require('./providers/alpacaService');
const { fetchJson, scoreConsolidation } = require('./marketDataService');
const { average } = require('./mathUtils');
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

  const candidates = await fetchScreenerCandidates(exchange);
  if (!candidates || !candidates.length) {
    return null;
  }

  const stocks = await buildUniverseFromBars(exchange, candidates);
  if (!stocks.length) {
    return null;
  }

  writeCache(cacheKey, stocks);
  return stocks;
}

// Stage 1: one FMP screener call for candidates that are already small-cap, liquid, and above a
// penny-stock price floor - with real market cap attached, so nothing per-symbol is needed later.
async function fetchScreenerCandidates(exchange) {
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
async function buildUniverseFromBars(exchange, candidates) {
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

    const stock = buildStockFromBars(exchange, candidate, bars);
    if (stock) {
      stocks.push(stock);
    }
  }

  return stocks;
}

// bars is oldest-to-newest (alpacaService contract). Field names/definitions mirror
// marketDataService.js exactly so downstream scoring code can't tell the difference.
function buildStockFromBars(exchange, candidate, bars) {
  const last = bars[bars.length - 1];
  const previous = bars[bars.length - 2];
  const price = Number(last?.c);
  const previousClose = Number(previous?.c);

  if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose <= 0) {
    return null;
  }

  const closes = bars.map((bar) => Number(bar.c)).filter(Number.isFinite);
  const highs = bars.map((bar) => Number(bar.h)).filter(Number.isFinite);
  const lows = bars.map((bar) => Number(bar.l)).filter(Number.isFinite);
  const volumes = bars.map((bar) => Number(bar.v)).filter(Number.isFinite);
  const imputedFields = [];

  const dailyChange = ((price - previousClose) / previousClose) * 100;
  const lastOpen = Number(last?.o);
  const gapPct = Number.isFinite(lastOpen) ? ((lastOpen - previousClose) / previousClose) * 100 : 0;

  const last20 = bars.slice(-20);
  const adrValues = last20
    .filter((bar) => Number.isFinite(bar.h) && Number.isFinite(bar.l) && bar.l > 0)
    .map((bar) => ((bar.h - bar.l) / bar.l) * 100);
  const adrPct = adrValues.length ? average(adrValues) : 0;

  const volume = Number(last?.v) || 0;
  const averageVolume30d = volumes.length ? average(volumes.slice(-30)) : 0;

  const high52w = highs.length ? Math.max(...highs) : price;
  const low52w = lows.length ? Math.min(...lows) : price;

  const last50Closes = closes.slice(-50);
  if (last50Closes.length < 50) {
    imputedFields.push('MA50');
  }
  const ma50 = last50Closes.length ? average(last50Closes) : price;

  const last200Closes = closes.slice(-200);
  if (last200Closes.length < 200) {
    imputedFields.push('MA200');
  }
  const ma200 = last200Closes.length ? average(last200Closes) : price;

  const previousMa50 = average(closes.slice(-55, -5)) || ma50;
  const ma50Slope = previousMa50 ? (ma50 - previousMa50) / previousMa50 : 0;

  const returns = closes.slice(1).map((value, index) => (closes[index] ? (value - closes[index]) / closes[index] : 0));
  const volatility = standardDeviation(returns.slice(-20));

  const return3m = computeReturnPctFromEnd(closes, 63);

  const lastHigh = Number(last?.h);
  const priceNearDailyHigh = Number.isFinite(lastHigh) && lastHigh > 0 ? price / lastHigh : 0.9;

  // No fundamentals in this path (the screener call already spent our FMP budget on candidates,
  // not per-symbol profile/growth lookups) - flagged as imputed rather than fabricated.
  imputedFields.push('revenue_growth_pct', 'dividend_yield');

  return {
    ticker: candidate.symbol,
    companyName: candidate.companyName,
    sector: candidate.sector,
    exchange,
    price,
    daily_change: dailyChange,
    gap_pct: gapPct,
    volume,
    average_volume_30d: averageVolume30d,
    market_cap: candidate.marketCap,
    dividend_yield: 0,
    MA50: ma50,
    MA200: ma200,
    high_52w: high52w,
    low_52w: low52w,
    volatility,
    return_3m: Number.isFinite(return3m) ? return3m : 0,
    revenue_growth_pct: 0,
    adr_pct: adrPct,
    ma50_slope: ma50Slope,
    price_near_daily_high: priceNearDailyHigh,
    consolidation_score: scoreConsolidation(closes.slice(-20), high52w, low52w),
    data_source: 'alpaca+fmp-screener',
    imputedFields
  };
}

function standardDeviation(values) {
  const filtered = values.filter(Number.isFinite);
  if (!filtered.length) {
    return 0;
  }

  const mean = average(filtered);
  const variance = average(filtered.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

// closes is oldest-to-newest; anchor ~63 trading days back from the latest close.
function computeReturnPctFromEnd(closes, windowDays) {
  const price = closes[closes.length - 1];
  const anchor = closes[closes.length - 1 - windowDays];
  return Number.isFinite(anchor) && anchor > 0 && Number.isFinite(price) ? ((price - anchor) / anchor) * 100 : NaN;
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
