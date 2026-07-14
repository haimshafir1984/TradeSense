// Called as marketDataService.getMarketData(...) rather than destructured, so tests can
// monkey-patch the export without needing to reload this module (same pattern as
// scanHistoryService.js).
const marketDataService = require('./marketDataService');
const watchlistStore = require('./watchlistStore');
// funnelScanService is tried first (wide Alpaca-backed scan); this module only runs its own
// FMP-universe path as a fallback when funnelScanService returns null (Alpaca not configured, or
// its stage 1 failed). See docs/SPEC_DATA_FUNNEL.md section 3.3.
const funnelScanService = require('./funnelScanService');
const { round } = require('./mathUtils');
const {
  MAX_WATCHLIST_SIZE,
  MARKET_CAP_CEILING,
  MIN_ADR_PCT,
  MIN_VOLUME_RATIO,
  computeRankScore,
  buildReason,
  resolveEarningsSoon
} = require('./watchlistScoring');

// A cached watchlist stays valid this long before a request is forced to recompute it, even if
// the nightly scheduler (watchlistScheduler.js) never got to run - e.g. the server wasn't running
// overnight. This keeps GET /api/watchlist/tomorrow instant on the common path (already computed
// by the scheduler or an earlier request today) without ever serving something wildly stale.
const CACHE_FRESHNESS_MS = 12 * 60 * 60 * 1000;

// Turns the EOD-only limitation into an advantage: instead of trying (and failing) to compete
// with real-time day-trading tools, an evening scan surfaces gap-and-go candidates for the next
// session's open. See docs/LOGIC_IMPROVEMENTS.md - Watchlist for Tomorrow.
// Returns { watchlist, dataSource } - dataSource is tracked at this level (not inferred from
// watchlist[0]) specifically so a *legitimate* empty result from the broad Alpaca funnel ("scanned
// everything, found zero real candidates today") is never confused with the narrow FMP-universe
// fallback. Before this, an empty funnel result had no items to carry a per-item dataSource, so the
// caller fell back to labeling it as the narrow sample - misleading the user into thinking the
// wide scan didn't run at all when it actually did.
async function buildTomorrowWatchlist({ exchange = 'NASDAQ' } = {}) {
  // A returned array (even an empty one) means the funnel actually ran - "no candidates today" is
  // a legitimate result and short-circuits the old path. null means Alpaca isn't configured or its
  // stage 1 failed, so we fall through to exactly the same FMP-universe logic as before.
  const funnelResult = await funnelScanService.scanForGapAndGo({ exchange });
  if (Array.isArray(funnelResult)) {
    return { watchlist: funnelResult, dataSource: 'alpaca+fmp' };
  }

  const { stocks } = await marketDataService.getMarketData(exchange);

  const candidates = stocks
    .map(enrichCandidate)
    .filter(matchesGapAndGoProfile)
    .sort((left, right) => right.rankScore - left.rankScore)
    .slice(0, MAX_WATCHLIST_SIZE);

  const apiKey = process.env.FMP_API_KEY;
  const watchlist = await Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      hasEarningsSoon: await resolveEarningsSoon(candidate.ticker, apiKey),
      dataSource: 'fmp-universe'
    }))
  );

  return { watchlist, dataSource: 'fmp-universe' };
}

// Read-through cache in front of buildTomorrowWatchlist, keyed by exchange. This is what lets the
// nightly scheduler (watchlistScheduler.js) do the (slower, earnings-lookup-heavy) computation
// once in the evening, so opening the app later just serves the already-computed result instantly
// instead of recomputing on every page load.
async function getTomorrowWatchlist({ exchange = 'NASDAQ', forceRefresh = false } = {}) {
  const cache = await watchlistStore.readWatchlistCache();
  const cached = cache[exchange];
  const isFresh = cached && Date.now() - new Date(cached.generatedAt).getTime() < CACHE_FRESHNESS_MS;

  if (isFresh && !forceRefresh) {
    return cached;
  }

  const { watchlist, dataSource } = await buildTomorrowWatchlist({ exchange });
  const entry = { generatedAt: new Date().toISOString(), watchlist, dataSource };

  cache[exchange] = entry;
  await watchlistStore.writeWatchlistCache(cache);

  return entry;
}

function enrichCandidate(stock) {
  const volumeRatio = stock.average_volume_30d ? stock.volume / stock.average_volume_30d : 0;
  const highProximity = stock.high_52w ? stock.price / stock.high_52w : 0;
  const adrPct = Number(stock.adr_pct || 0);
  const dailyChange = Number(stock.daily_change || 0);
  const rankScore = computeRankScore({ dailyChange, volumeRatio, highProximity });

  return {
    ticker: stock.ticker,
    companyName: stock.companyName,
    price: round(stock.price, 2),
    daily_change: round(dailyChange, 2),
    volumeRatio: round(volumeRatio, 2),
    adr_pct: round(adrPct, 2),
    highProximity: round(highProximity, 3),
    market_cap: Math.round(stock.market_cap),
    rankScore: round(rankScore, 4),
    reason: buildReason(dailyChange, volumeRatio, adrPct, highProximity)
  };
}

function matchesGapAndGoProfile(candidate) {
  return (
    candidate.market_cap < MARKET_CAP_CEILING &&
    candidate.adr_pct >= MIN_ADR_PCT &&
    candidate.volumeRatio >= MIN_VOLUME_RATIO &&
    candidate.daily_change > 0
  );
}

module.exports = {
  buildTomorrowWatchlist,
  getTomorrowWatchlist
};
